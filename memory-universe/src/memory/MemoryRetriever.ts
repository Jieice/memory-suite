/**
 * Phase 2: 记忆检索器
 * 负责从向量库中检索相关记忆并构建上下文
 */

import { MemoryContext, MemorySearchResult, UserMemoryProfile, MemoryType } from './types';
import { VectorStore } from './VectorStore';
import { embeddingService } from './EmbeddingService';

export interface RetrievalOptions {
    topK?: number;
    includeUserProfile?: boolean;
    timeWeight?: number;      // 时间权重 (0-1)，阶段 A3：近期记忆权重大
    emotionWeight?: number;   // 情感权重 (0-1)
    requestId?: string;       // 全链路 requestId，用于日志
    /** 阶段 A3：按类型过滤，只保留指定类型的记忆 */
    memoryTypes?: MemoryType[];
}

/** 记忆检索可观测：最近一次与累计统计 */
export interface RetrievalStats {
    lastCount: number;
    lastMs: number;
    lastAt: number;
    totalRetrievals: number;
    totalRetrievalMs: number;
}

const retrievalStats: RetrievalStats = {
    lastCount: 0,
    lastMs: 0,
    lastAt: 0,
    totalRetrievals: 0,
    totalRetrievalMs: 0
};

export function getRetrievalStats(): RetrievalStats {
    return { ...retrievalStats };
}

import { SimpleMemCompressor } from './SimpleMemCompressor';

export class MemoryRetriever {
    private vectorStore: VectorStore;
    private userProfiles: Map<string, UserMemoryProfile> = new Map();
    private compressor: SimpleMemCompressor;

    constructor(vectorStore: VectorStore) {
        this.vectorStore = vectorStore;
        this.compressor = new SimpleMemCompressor();
    }

    private tokenizeForRank(text: string): Set<string> {
        const src = (text || '').toLowerCase().trim();
        if (!src) return new Set<string>();
        const tokens = new Set<string>();
        const words = src.match(/[a-z0-9_]{2,}/g) || [];
        for (const token of words) tokens.add(token);
        const chinese = src.match(/[\u4e00-\u9fff]{2,4}/g) || [];
        for (const token of chinese) tokens.add(token);
        return tokens;
    }

    private lexicalOverlap(query: string, memoryText: string): number {
        const q = this.tokenizeForRank(query);
        const m = this.tokenizeForRank(memoryText);
        if (q.size === 0 || m.size === 0) return 0;
        let hit = 0;
        for (const token of q) {
            if (m.has(token)) hit += 1;
        }
        return hit / q.size;
    }

    private typeBoost(type: string): number {
        if (type === 'core') return 0.1;
        if (type === 'semantic') return 0.06;
        return 0;
    }

    /** 阶段 A3：支持 timeWeight 放大近期记忆权重、memoryTypes 过滤 */
    private rerankForDialogue(
        query: string,
        userId: string | undefined,
        results: MemorySearchResult[],
        opts?: { timeWeight?: number; memoryTypes?: MemoryType[] }
    ): MemorySearchResult[] {
        let input = results;
        if (opts?.memoryTypes?.length) {
            const set = new Set(opts.memoryTypes);
            input = input.filter((item) => item.memory?.type && set.has(item.memory.type));
        }
        const tw = opts?.timeWeight ?? 0.2;
        const recencyScale = 0.08 + Math.min(0.5, tw * 0.35);
        const ranked = [...input]
            .map((item) => {
                const lexical = this.lexicalOverlap(query, item.memory?.content || '');
                const sameUserBoost = userId && item.memory?.userId === userId ? 0.12 : 0;
                const sourceBoost = item.memory?.metadata?.source === 'creator' ? 0.04 : 0;
                const recencyBoost = Math.max(0, item.recency - 0.4) * recencyScale;
                const score = item.relevance * 0.75
                    + lexical * 0.18
                    + sameUserBoost
                    + sourceBoost
                    + recencyBoost
                    + this.typeBoost(item.memory?.type || 'episodic');
                return {
                    ...item,
                    relevance: Number(score.toFixed(6))
                };
            })
            .sort((a, b) => b.relevance - a.relevance);

        const seen = new Set<string>();
        const deduped: MemorySearchResult[] = [];
        for (const item of ranked) {
            const key = (item.memory?.content || '')
                .toLowerCase()
                .replace(/[\s\.,;:!?，。！？；：'"`~\-_\[\]\(\)\{\}]/g, '')
                .slice(0, 120);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            deduped.push(item);
        }
        return deduped;
    }

    /**
     * 检索与查询相关的记忆
     */
    async retrieve(
        query: string,
        userId?: string,
        options: RetrievalOptions = {}
    ): Promise<MemoryContext> {
        const t0 = Date.now();
        const rid = options.requestId || 'na';
        const {
            topK = 3,
            includeUserProfile = true,
            timeWeight = 0.2,
            emotionWeight = 0.1
        } = options;

        // 1. 生成查询向量
        const queryEmbedding = await embeddingService.embed(query);

        // 2. 向量搜索（阶段 A3：可选按 memoryTypes 单类型过滤）
        const singleType = options.memoryTypes?.length === 1 ? options.memoryTypes[0] : undefined;
        let searchResults = this.vectorStore.search(queryEmbedding, {
            topK: topK * 2,
            minSimilarity: 0.25,
            type: singleType
        });

        // 3. 如果有用户 ID，额外搜索该用户的历史
        if (userId) {
            const userResults = this.vectorStore.search(queryEmbedding, {
                topK: 5,
                userId,
                minSimilarity: 0.18,
                type: singleType
            });
            const existingIds = new Set(searchResults.map(r => r.memory.id));
            for (const result of userResults) {
                if (!existingIds.has(result.memory.id)) {
                    result.relevance *= 1.35;
                    searchResults.push(result);
                }
            }
            
            const canonicalFacts = this.getCanonicalMemoryForUser(userId);
            for (const fact of canonicalFacts) {
                const factEmbedding = await embeddingService.embed(fact);
                const similarity = this.cosineSimilarity(queryEmbedding, factEmbedding);
                if (similarity > 0.3) {
                    searchResults.push({
                        memory: {
                            id: `canon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                            content: fact,
                            type: 'core',
                            userId,
                            timestamp: Date.now(),
                            embedding: factEmbedding,
                            importance: 0.9,
                            emotionalValence: 0,
                            accessCount: 1,
                            lastAccess: Date.now(),
                            metadata: { source: 'canonical' }
                        },
                        similarity,
                        relevance: similarity * 1.5,
                        recency: 1.0
                    });
                }
            }
        }

        // 4. 重新排序并截取（阶段 A3：传入 timeWeight、memoryTypes 多类型过滤在 rerank 内）
        const reranked = this.rerankForDialogue(query, userId, searchResults, {
            timeWeight: options.timeWeight,
            memoryTypes: options.memoryTypes?.length ? options.memoryTypes : undefined
        });

        // SimpleMem Optimization: Compress and Filter
        const relatedMemories = this.compressor.compress(reranked.slice(0, topK * 2)).slice(0, topK);

        // 5. 获取用户画像
        let userProfile: UserMemoryProfile | undefined;
        if (includeUserProfile && userId) {
            userProfile = await this.getUserProfile(userId);
        }

        // 6. 生成摘要
        const summary = this.buildSummary(relatedMemories, userProfile);

        // 可观测：打点
        const ms = Date.now() - t0;
        retrievalStats.lastCount = relatedMemories.length;
        retrievalStats.lastMs = ms;
        retrievalStats.lastAt = Date.now();
        retrievalStats.totalRetrievals += 1;
        retrievalStats.totalRetrievalMs += ms;
        if (rid !== 'na') {
            console.log(`[MemoryRetriever] rid=${rid} count=${relatedMemories.length} ms=${ms}`);
        }

        return {
            relatedMemories,
            userProfile,
            summary
        };
    }

    /**
     * 检索累积情绪 (用于检测"累积愤怒"等)
     */
    async retrieveEmotionalHistory(
        userId: string,
        emotionType: 'positive' | 'negative',
        timeWindowMs: number = 24 * 60 * 60 * 1000 // 默认24小时
    ): Promise<{ count: number; averageValence: number; memories: MemorySearchResult[] }> {
        const now = Date.now();
        const memories = this.vectorStore.getByTimeRange(now - timeWindowMs, now)
            .filter(m => m.userId === userId);

        const filtered = memories.filter(m => {
            if (emotionType === 'positive') return m.emotionalValence > 0.2;
            return m.emotionalValence < -0.2;
        });

        const averageValence = filtered.length > 0
            ? filtered.reduce((sum, m) => sum + m.emotionalValence, 0) / filtered.length
            : 0;

        return {
            count: filtered.length,
            averageValence,
            memories: filtered.map(m => ({
                memory: m,
                similarity: 1,
                recency: 1,
                relevance: 1
            }))
        };
    }

    /**
     * 获取或创建用户画像
     */
    async getUserProfile(userId: string): Promise<UserMemoryProfile> {
        // 先检查缓存
        if (this.userProfiles.has(userId)) {
            return this.userProfiles.get(userId)!;
        }

        // 从记忆中聚合
        const userMemories = this.vectorStore.getByUserId(userId, 100);

        if (userMemories.length === 0) {
            return {
                userId,
                totalInteractions: 0,
                averageSentiment: 0,
                tags: [],
                lastSeen: Date.now(),
                coreMemories: []
            };
        }

        // 计算统计
        const totalInteractions = userMemories.length;
        const averageSentiment = userMemories.reduce((sum, m) => sum + m.emotionalValence, 0) / totalInteractions;
        const lastSeen = Math.max(...userMemories.map(m => m.timestamp));

        // 生成标签
        const tags = this.generateUserTags(userMemories, averageSentiment);

        // 提取核心记忆
        const coreMemories = userMemories
            .filter(m => m.type === 'core' || m.importance > 0.7)
            .slice(0, 3)
            .map(m => m.content);

        const profile: UserMemoryProfile = {
            userId,
            totalInteractions,
            averageSentiment,
            tags,
            lastSeen,
            coreMemories
        };

        this.userProfiles.set(userId, profile);
        return profile;
    }

    /**
     * 根据记忆生成用户标签
     */
    private generateUserTags(memories: any[], averageSentiment: number): string[] {
        const tags: string[] = [];

        // 基于情感
        if (averageSentiment < -0.3) {
            tags.push('黑粉');
        } else if (averageSentiment > 0.5) {
            tags.push('铁粉');
        }

        // 基于互动频率
        if (memories.length > 50) {
            tags.push('老观众');
        } else if (memories.length > 20) {
            tags.push('常客');
        }

        // 基于礼物
        const giftCount = memories.filter(m => m.metadata?.source === 'gift').length;
        if (giftCount > 10) {
            tags.push('送礼大户');
        }

        return tags;
    }

    /**
     * 构建记忆摘要 (用于注入 Prompt)
     */
    private buildSummary(memories: MemorySearchResult[], profile?: UserMemoryProfile): string {
        if (memories.length === 0 && !profile) {
            return '';
        }

        const parts: string[] = [];

        // 用户画像
        if (profile && profile.totalInteractions > 0) {
            const tagStr = profile.tags.length > 0 ? `(${profile.tags.join(', ')})` : '';
            parts.push(`【用户档案】${tagStr} 互动${profile.totalInteractions}次`);

            if (profile.coreMemories.length > 0) {
                parts.push(`核心印象: ${profile.coreMemories[0]}`);
            }
        }

        // 相关记忆
        if (memories.length > 0) {
            parts.push('【相关记忆】');
            memories.forEach((result, idx) => {
                const timeAgo = this.formatTimeAgo(result.memory.timestamp);
                parts.push(`${idx + 1}. [${timeAgo}] ${result.memory.content.slice(0, 50)}...`);
            });
        }

        return parts.join('\n');
    }

    /**
     * 格式化时间差
     */
    private formatTimeAgo(timestamp: number): string {
        const diff = Date.now() - timestamp;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (days > 0) return `${days}天前`;
        if (hours > 0) return `${hours}小时前`;
        if (minutes > 0) return `${minutes}分钟前`;
        return '刚才';
    }

    /**
     * 清除用户画像缓存
     */
    clearProfileCache(userId?: string): void {
        if (userId) {
            this.userProfiles.delete(userId);
        } else {
            this.userProfiles.clear();
        }
    }

    private canonicalMemoryCache: Map<string, string[]> = new Map();

    setCanonicalMemory(userId: string, facts: string[]): void {
        this.canonicalMemoryCache.set(userId, facts);
    }

    getCanonicalMemoryForUser(userId: string): string[] {
        return this.canonicalMemoryCache.get(userId) || [];
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        if (!a || !b || a.length !== b.length) return 0;
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom > 0 ? dot / denom : 0;
    }
}
