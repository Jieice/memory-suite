/**
 * Phase 2: 做梦/反思服务
 * 定期对记忆进行整理、压缩和反思
 */

import { MemoryRecord, ReflectionResult, UserMemoryProfile } from './types';
import { VectorStore } from './VectorStore';
import { MemoryEncoder } from './MemoryEncoder';
import axios from 'axios';

export interface DreamingConfig {
    enabled: boolean;
    scheduleHour: number;      // 每天几点执行 (0-23)
    minMemoriesForReflection: number;
    useLLMForSummary: boolean;
    runOnStartup: boolean;     // 启动时执行
    runOnShutdown: boolean;    // 关闭时执行
    runEveryNTurns: number;    // 每N轮对话执行
}

const DEFAULT_CONFIG: DreamingConfig = {
    enabled: true,
    scheduleHour: 4,           // 凌晨4点
    minMemoriesForReflection: 10,
    useLLMForSummary: true,
    runOnStartup: true,
    runOnShutdown: true,
    runEveryNTurns: 0          // 0 = 禁用
};

export class DreamingService {
    private vectorStore: VectorStore;
    private encoder: MemoryEncoder;
    private config: DreamingConfig;
    private lastDreamDate: string | null = null;
    private dreamTimer: NodeJS.Timeout | null = null;

    constructor(
        vectorStore: VectorStore,
        encoder: MemoryEncoder,
        config: Partial<DreamingConfig> = {}
    ) {
        this.vectorStore = vectorStore;
        this.encoder = encoder;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * 启动定时做梦任务
     */
    start(): void {
        if (!this.config.enabled) return;

        this.dreamTimer = setInterval(() => {
            this.checkAndDream();
        }, 60 * 60 * 1000);

        console.log(`💤 [Dreaming] Service started, scheduled at ${this.config.scheduleHour}:00 (manual mode)`);
    }

    stop(): void {
        if (this.dreamTimer) {
            clearInterval(this.dreamTimer);
            this.dreamTimer = null;
        }
    }

    async shutdown(): Promise<void> {
        if (this.config.runOnShutdown) {
            console.log('💤 [Dreaming] Running shutdown dream...');
            try {
                await this.dream();
            } catch (e) {
                console.error('[Dreaming] Shutdown dream failed:', (e as Error).message);
            }
        }
    }

    /**
     * 检查是否需要做梦
     */
    private async checkAndDream(): Promise<void> {
        const now = new Date();
        const currentHour = now.getHours();
        const today = now.toISOString().split('T')[0];

        // 检查是否到了做梦时间且今天还没做过
        if (currentHour === this.config.scheduleHour && this.lastDreamDate !== today) {
            console.log('🌙 [Dreaming] Starting nightly reflection...');
            await this.dream();
            this.lastDreamDate = today;
        }
    }

    /**
     * 手动触发做梦 (用于测试或服务重启时)
     */
    async dream(): Promise<ReflectionResult> {
        const startTime = Date.now();
        const today = new Date().toISOString().split('T')[0];

        // 1. 获取最近24小时的情景记忆
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const recentMemories = this.vectorStore.getByTimeRange(oneDayAgo, Date.now())
            .filter(m => m.type === 'episodic');

        console.log(`🧠 [Dreaming] Processing ${recentMemories.length} recent memories...`);

        if (recentMemories.length < this.config.minMemoriesForReflection) {
            console.log('💤 [Dreaming] Not enough memories to reflect on');
            return {
                date: today,
                memoriesProcessed: 0,
                coreMemoriesCreated: [],
                userProfilesUpdated: []
            };
        }

        // 2. 按用户分组
        const byUser = this.groupByUser(recentMemories);
        const coreMemoriesCreated: MemoryRecord[] = [];
        const userProfilesUpdated: string[] = [];

        // 3. 为每个用户生成核心记忆
        for (const [userId, memories] of byUser) {
            if (memories.length < 3) continue;

            try {
                const coreMemory = await this.reflectOnUser(userId, memories);
                if (coreMemory) {
                    const id = await this.vectorStore.add(coreMemory);
                    coreMemoriesCreated.push({ ...coreMemory, id, accessCount: 0, lastAccess: Date.now() });
                    userProfilesUpdated.push(userId);
                }
            } catch (error: any) {
                console.error(`❌ [Dreaming] Failed to reflect on user ${userId}: ${error.message}`);
            }
        }

        // 4. 生成整体日报
        if (recentMemories.length >= 10) {
            try {
                const dailySummary = await this.generateDailySummary(recentMemories);
                if (dailySummary) {
                    const summaryMemory = await this.encoder.encodeCoreMemory(
                        `[${today}日报] ${dailySummary}`
                    );
                    await this.vectorStore.add(summaryMemory);
                }
            } catch (error: any) {
                console.error(`❌ [Dreaming] Failed to generate daily summary: ${error.message}`);
            }
        }

        // 5. 阶段 B3：Mem0 式循环 - 从近期情景记忆提取事实，写入语义记忆（默认开启）
        if (process.env.MEM0_STYLE_CONSOLIDATION_ENABLED !== 'false' && recentMemories.length >= 5) {
            try {
                const added = await this.consolidateRecentEpisodic(recentMemories);
                if (added > 0) console.log(`🧩 [Dreaming] Mem0-style: added ${added} semantic facts from recent episodic`);
            } catch (error: any) {
                console.error(`❌ [Dreaming] Mem0-style consolidation failed: ${error.message}`);
            }
        }

        const elapsed = Date.now() - startTime;
        console.log(`✨ [Dreaming] Reflection complete in ${elapsed}ms. Created ${coreMemoriesCreated.length} core memories.`);

        return {
            date: today,
            memoriesProcessed: recentMemories.length,
            coreMemoriesCreated,
            userProfilesUpdated
        };
    }

    /**
     * 按用户分组记忆
     */
    private groupByUser(memories: MemoryRecord[]): Map<string, MemoryRecord[]> {
        const groups = new Map<string, MemoryRecord[]>();
        
        for (const memory of memories) {
            const userId = memory.userId || 'anonymous';
            if (!groups.has(userId)) {
                groups.set(userId, []);
            }
            groups.get(userId)!.push(memory);
        }

        return groups;
    }

    /**
     * 对单个用户的记忆进行反思
     */
    private async reflectOnUser(
        userId: string,
        memories: MemoryRecord[]
    ): Promise<Omit<MemoryRecord, 'id' | 'accessCount' | 'lastAccess'> | null> {
        // 计算情感趋势
        const avgSentiment = memories.reduce((sum, m) => sum + m.emotionalValence, 0) / memories.length;
        
        // 提取关键内容
        const contents = memories.map(m => m.content).join('\n');

        let insight: string;

        if (this.config.useLLMForSummary && process.env.USE_LLM_API !== 'false') {
            // 使用 LLM 生成洞察
            insight = await this.generateInsightWithLLM(userId, contents, avgSentiment);
        } else {
            // 规则生成
            insight = this.generateInsightWithRules(userId, memories, avgSentiment);
        }

        if (!insight) return null;

        return this.encoder.encodeCoreMemory(insight, userId);
    }

    /**
     * 使用 LLM 生成用户洞察
     */
    private async generateInsightWithLLM(
        userId: string,
        contents: string,
        avgSentiment: number
    ): Promise<string> {
        try {
            const apiKey = process.env.DEEPSEEK_API_KEY;
            const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

            const response = await axios.post(
                `${baseUrl}/chat/completions`,
                {
                    model: 'deepseek-chat',
                    messages: [
                        {
                            role: 'system',
                            content: '你是一个记忆整理助手。请根据以下对话记录，用一句话总结这个用户的特点或与主播的关系。要简洁、有洞察力。'
                        },
                        {
                            role: 'user',
                            content: `用户ID: ${userId}\n平均情感: ${avgSentiment.toFixed(2)}\n对话记录:\n${contents.slice(0, 1000)}`
                        }
                    ],
                    max_tokens: 50,
                    temperature: 0.7
                },
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            return response.data.choices?.[0]?.message?.content || '';
        } catch (error: any) {
            console.error(`❌ [Dreaming] LLM call failed: ${error.message}`);
            return '';
        }
    }

    /**
     * 使用规则生成用户洞察
     */
    private generateInsightWithRules(
        userId: string,
        memories: MemoryRecord[],
        avgSentiment: number
    ): string {
        const count = memories.length;
        
        if (avgSentiment < -0.3) {
            return `用户${userId.slice(-4)}是个黑粉，经常发负面弹幕，共互动${count}次`;
        } else if (avgSentiment > 0.5) {
            return `用户${userId.slice(-4)}是铁粉，态度友好，共互动${count}次`;
        } else if (count > 10) {
            return `用户${userId.slice(-4)}是活跃观众，今日互动${count}次`;
        }

        return '';
    }

    /**
     * 阶段 B3：从近期情景记忆提取 1～2 条事实，写入语义记忆（Mem0 式循环）
     */
    private async consolidateRecentEpisodic(recentMemories: MemoryRecord[]): Promise<number> {
        const byUser = this.groupByUser(recentMemories);
        let added = 0;
        for (const [userId, memories] of byUser) {
            if (memories.length < 3) continue;
            const last = memories.slice(-5).map((m) => m.content).join('\n');
            const facts = await this.extractFactsWithLLM(last);
            for (const fact of facts.slice(0, 2)) {
                if (!fact || fact.length > 150) continue;
                const semantic = await this.encoder.encodeSemanticMemory(fact, userId);
                await this.vectorStore.add(semantic);
                added += 1;
            }
        }
        return added;
    }

    private async extractFactsWithLLM(contents: string): Promise<string[]> {
        try {
            const apiKey = process.env.DEEPSEEK_API_KEY;
            const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
            if (!apiKey) return [];
            const response = await axios.post(
                `${baseUrl}/chat/completions`,
                {
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'system', content: '你从对话记录中提取 1～2 条关键事实，每行一句，简短。不要编号或前缀。' },
                        { role: 'user', content: contents.slice(0, 800) }
                    ],
                    max_tokens: 80,
                    temperature: 0.2
                },
                { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 8000 }
            );
            const text = response.data.choices?.[0]?.message?.content || '';
            return text.split(/\n/).map((s: string) => s.replace(/^\d+[\.\)]\s*/, '').trim()).filter((s: string) => s.length > 2 && s.length < 150);
        } catch (error: any) {
            return [];
        }
    }

    /**
     * 生成每日总结
     */
    private async generateDailySummary(memories: MemoryRecord[]): Promise<string> {
        const totalCount = memories.length;
        const uniqueUsers = new Set(memories.map(m => m.userId)).size;
        const avgSentiment = memories.reduce((sum, m) => sum + m.emotionalValence, 0) / totalCount;

        const moodDesc = avgSentiment > 0.3 ? '氛围很好' : avgSentiment < -0.2 ? '有些负面' : '平平淡淡';

        return `今日共${totalCount}条互动，${uniqueUsers}位观众，整体${moodDesc}`;
    }
}
