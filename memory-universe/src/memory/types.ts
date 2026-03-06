/**
 * Phase 2: 海马体 - 记忆流类型定义
 * BrainNN V7 Memory Stream Types
 */

/**
 * 记忆类型
 * - episodic: 情景记忆 (具体事件，如"用户A说了XXX")
 * - semantic: 语义记忆 (抽象知识，如"用户A是黑粉")
 * - core: 核心记忆 (经过反思压缩的重要记忆)
 */
export type MemoryType = 'episodic' | 'semantic' | 'core';

/**
 * 单条记忆记录
 */
export interface MemoryRecord {
    id: string;
    content: string;
    embedding: number[];
    timestamp: number;
    type: MemoryType;
    importance: number;        // 0-1, 重要性评分
    userId?: string;           // 关联用户
    emotionalValence: number;  // -1 到 1, 情感效价
    accessCount: number;       // 访问次数 (用于衰减)
    lastAccess: number;        // 最后访问时间
    metadata?: Record<string, any>;
}

/**
 * 记忆检索结果
 */
export interface MemorySearchResult {
    memory: MemoryRecord;
    similarity: number;  // 余弦相似度
    recency: number;     // 时间新鲜度 0-1
    relevance: number;   // 综合相关性得分
}

/**
 * 记忆上下文 (注入到 Prompt 中)
 */
export interface MemoryContext {
    relatedMemories: MemorySearchResult[];
    userProfile?: UserMemoryProfile;
    summary: string;
}

/**
 * 用户记忆画像 (从多次交互中聚合)
 */
export interface UserMemoryProfile {
    userId: string;
    totalInteractions: number;
    averageSentiment: number;
    tags: string[];           // 如 ["黑粉", "老观众", "送礼大户"]
    lastSeen: number;
    coreMemories: string[];   // 关于此用户的核心记忆摘要
}

/**
 * 反思/做梦结果
 */
export interface ReflectionResult {
    date: string;
    memoriesProcessed: number;
    coreMemoriesCreated: MemoryRecord[];
    userProfilesUpdated: string[];
}
