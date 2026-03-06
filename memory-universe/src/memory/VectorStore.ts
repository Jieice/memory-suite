/**
 * Phase 2: 轻量级向量存储
 * 使用 JSON 文件持久化 + 内存索引
 * 适合中小规模记忆 (<10k 条)
 */

import fs from 'fs';
import path from 'path';
import { MemoryRecord, MemorySearchResult, MemoryType } from './types';
import { EmbeddingService } from './EmbeddingService';

export interface VectorStoreConfig {
    dataDir: string;
    maxMemories: number;
    autoSaveInterval: number;  // ms
}

const DEFAULT_CONFIG: VectorStoreConfig = {
    dataDir: path.join(process.cwd(), 'data', 'memories'),
    maxMemories: 5000,
    autoSaveInterval: 60000  // 1分钟自动保存
};

export class VectorStore {
    private memories: Map<string, MemoryRecord> = new Map();
    private config: VectorStoreConfig;
    private isDirty: boolean = false;
    private saveTimer: NodeJS.Timeout | null = null;

    constructor(config: Partial<VectorStoreConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.ensureDataDir();
        this.load();
        this.startAutoSave();
    }

    private ensureDataDir(): void {
        if (!fs.existsSync(this.config.dataDir)) {
            fs.mkdirSync(this.config.dataDir, { recursive: true });
            console.log(`📁 [VectorStore] Created data directory: ${this.config.dataDir}`);
        }
    }

    private getFilePath(): string {
        return path.join(this.config.dataDir, 'memories.json');
    }

    /**
     * 从磁盘加载记忆
     */
    private load(): void {
        const filePath = this.getFilePath();
        if (fs.existsSync(filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                this.memories = new Map(data.memories || []);
                console.log(`📖 [VectorStore] Loaded ${this.memories.size} memories`);
            } catch (error: any) {
                console.error(`❌ [VectorStore] Failed to load: ${error.message}`);
                this.memories = new Map();
            }
        }
    }

    /**
     * 保存到磁盘
     */
    async save(): Promise<void> {
        if (!this.isDirty) return;

        const filePath = this.getFilePath();
        const data = {
            version: '1.0',
            savedAt: Date.now(),
            memories: Array.from(this.memories.entries())
        };

        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
            this.isDirty = false;
            console.log(`💾 [VectorStore] Saved ${this.memories.size} memories`);
        } catch (error: any) {
            console.error(`❌ [VectorStore] Failed to save: ${error.message}`);
        }
    }

    private startAutoSave(): void {
        this.saveTimer = setInterval(() => {
            this.save();
        }, this.config.autoSaveInterval);
    }

    /**
     * 生成唯一 ID
     */
    private generateId(): string {
        return `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * 添加记忆
     */
    async add(record: Omit<MemoryRecord, 'id' | 'accessCount' | 'lastAccess'>): Promise<string> {
        const id = this.generateId();
        const memory: MemoryRecord = {
            ...record,
            id,
            accessCount: 0,
            lastAccess: Date.now()
        };

        // 检查容量限制
        if (this.memories.size >= this.config.maxMemories) {
            await this.evictOldest();
        }

        this.memories.set(id, memory);
        this.isDirty = true;
        return id;
    }

    /**
     * 批量添加
     */
    async addBatch(records: Omit<MemoryRecord, 'id' | 'accessCount' | 'lastAccess'>[]): Promise<string[]> {
        const ids: string[] = [];
        for (const record of records) {
            ids.push(await this.add(record));
        }
        return ids;
    }

    /**
     * 向量相似度搜索
     */
    search(
        queryEmbedding: number[],
        options: {
            topK?: number;
            minSimilarity?: number;
            type?: MemoryType;
            userId?: string;
            timeRange?: { start: number; end: number };
        } = {}
    ): MemorySearchResult[] {
        const {
            topK = 5,
            minSimilarity = 0.3,
            type,
            userId,
            timeRange
        } = options;

        const now = Date.now();
        const results: MemorySearchResult[] = [];

        for (const memory of this.memories.values()) {
            // 过滤条件
            if (type && memory.type !== type) continue;
            if (userId && memory.userId !== userId) continue;
            if (timeRange) {
                if (memory.timestamp < timeRange.start || memory.timestamp > timeRange.end) continue;
            }

            // 计算相似度
            const similarity = EmbeddingService.cosineSimilarity(queryEmbedding, memory.embedding);
            if (similarity < minSimilarity) continue;

            // 计算时间新鲜度 (指数衰减，半衰期 7 天)
            const ageMs = now - memory.timestamp;
            const halfLifeMs = 7 * 24 * 60 * 60 * 1000;
            const recency = Math.exp(-ageMs / halfLifeMs);

            // 综合相关性 = 0.6 * 相似度 + 0.2 * 新鲜度 + 0.2 * 重要性
            const relevance = 0.6 * similarity + 0.2 * recency + 0.2 * memory.importance;

            results.push({ memory, similarity, recency, relevance });

            // 更新访问统计
            memory.accessCount++;
            memory.lastAccess = now;
        }

        // 按综合相关性排序
        results.sort((a, b) => b.relevance - a.relevance);
        this.isDirty = true;

        return results.slice(0, topK);
    }

    /**
     * 按用户 ID 获取记忆
     */
    getByUserId(userId: string, limit: number = 10): MemoryRecord[] {
        const userMemories: MemoryRecord[] = [];
        for (const memory of this.memories.values()) {
            if (memory.userId === userId) {
                userMemories.push(memory);
            }
        }
        return userMemories
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
    }

    /**
     * 获取指定时间范围内的记忆
     */
    getByTimeRange(start: number, end: number): MemoryRecord[] {
        const results: MemoryRecord[] = [];
        for (const memory of this.memories.values()) {
            if (memory.timestamp >= start && memory.timestamp <= end) {
                results.push(memory);
            }
        }
        return results.sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * 删除记忆
     */
    delete(id: string): boolean {
        const deleted = this.memories.delete(id);
        if (deleted) this.isDirty = true;
        return deleted;
    }

    /**
     * 淘汰最旧/最不重要的记忆
     */
    private async evictOldest(): Promise<void> {
        // 计算淘汰分数 = 重要性 * 0.5 + 新鲜度 * 0.3 + 访问频率 * 0.2
        const now = Date.now();
        const scored: { id: string; score: number }[] = [];

        for (const [id, memory] of this.memories) {
            const ageMs = now - memory.timestamp;
            const halfLifeMs = 7 * 24 * 60 * 60 * 1000;
            const recency = Math.exp(-ageMs / halfLifeMs);
            const accessFreq = Math.min(memory.accessCount / 10, 1);
            
            const score = memory.importance * 0.5 + recency * 0.3 + accessFreq * 0.2;
            scored.push({ id, score });
        }

        // 删除分数最低的 10%
        scored.sort((a, b) => a.score - b.score);
        const toDelete = Math.ceil(this.memories.size * 0.1);
        
        for (let i = 0; i < toDelete; i++) {
            this.memories.delete(scored[i].id);
        }

        console.log(`🗑️ [VectorStore] Evicted ${toDelete} old memories`);
        this.isDirty = true;
    }

    /**
     * 获取统计信息
     */
    getStats(): { total: number; byType: Record<MemoryType, number> } {
        const byType: Record<MemoryType, number> = {
            episodic: 0,
            semantic: 0,
            core: 0
        };

        for (const memory of this.memories.values()) {
            byType[memory.type]++;
        }

        return { total: this.memories.size, byType };
    }

    /**
     * 获取所有记忆 (用于反思)
     */
    getAll(): MemoryRecord[] {
        return Array.from(this.memories.values());
    }

    /**
     * 更新记忆
     */
    update(id: string, updates: Partial<MemoryRecord>): boolean {
        const memory = this.memories.get(id);
        if (!memory) return false;

        Object.assign(memory, updates);
        this.isDirty = true;
        return true;
    }

    /**
     * 清理资源
     */
    async dispose(): Promise<void> {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
        }
        await this.save();
    }
}
