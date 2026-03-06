/**
 * Phase 2: 记忆编码器
 * 将对话/事件转换为结构化记忆
 */

import { RawStreamInput, BrainSignal } from '../types/brain';
import { MemoryRecord, MemoryType } from './types';
import { embeddingService } from './EmbeddingService';

export interface EncodingContext {
    input: RawStreamInput;
    response?: string;
    signal?: BrainSignal;
}

export class MemoryEncoder {
    /**
     * 将一次交互编码为记忆
     */
    async encode(context: EncodingContext): Promise<Omit<MemoryRecord, 'id' | 'accessCount' | 'lastAccess'>> {
        const { input, response, signal } = context;

        // 1. 构建记忆内容
        const content = this.buildContent(input, response);

        // 2. 生成 Embedding
        const embedding = await embeddingService.embed(content);

        // 3. 计算重要性
        const importance = this.calculateImportance(input, signal);

        // 4. 提取情感效价
        const emotionalValence = this.extractEmotionalValence(signal);

        return {
            content,
            embedding,
            timestamp: input.features.timestamp || Date.now(),
            type: 'episodic',
            importance,
            userId: input.userId,
            emotionalValence,
            metadata: {
                source: input.source,
                userName: input.userName,
                responseText: response
            }
        };
    }

    /**
     * 构建记忆内容文本
     */
    private buildContent(input: RawStreamInput, response?: string): string {
        const parts: string[] = [];

        // 用户信息
        if (input.userName) {
            parts.push(`[${input.userName}]`);
        } else if (input.userId) {
            parts.push(`[用户${input.userId.slice(-4)}]`);
        }

        // 来源标记
        if (input.source === 'gift') {
            parts.push('(礼物)');
        } else if (input.source === 'creator') {
            parts.push('(主播)');
        }

        // 内容
        parts.push(input.content);

        // 回复
        if (response) {
            parts.push(`→ 回复: ${response}`);
        }

        return parts.join(' ');
    }

    /**
     * 计算记忆重要性 (0-1)
     */
    private calculateImportance(input: RawStreamInput, signal?: BrainSignal): number {
        let importance = 0.3; // 基础重要性

        // 1. 来源加权
        if (input.source === 'creator') {
            importance += 0.3; // 主播消息更重要
        } else if (input.source === 'gift') {
            importance += 0.2; // 礼物也比较重要
        }

        // 2. 强度加权
        importance += input.features.intensity * 0.2;

        // 3. 情绪冲击加权
        if (signal?.soul) {
            const emotion = signal.soul.emotion || {};
            const maxEmotion = Math.max(
                emotion['joy'] || 0,
                emotion['anger'] || 0,
                emotion['sadness'] || 0
            );
            importance += maxEmotion * 0.2;
        }

        // 4. 内容长度加权 (长消息可能更有信息量)
        const lengthBonus = Math.min(input.content.length / 100, 0.1);
        importance += lengthBonus;

        return Math.min(importance, 1.0);
    }

    /**
     * 提取情感效价 (-1 到 1)
     */
    private extractEmotionalValence(signal?: BrainSignal): number {
        if (!signal?.soul?.emotion) return 0;

        const emotion = signal.soul.emotion;
        const positive = (emotion['joy'] || 0) + (emotion['trust'] || 0);
        const negative = (emotion['anger'] || 0) + (emotion['sadness'] || 0) + (emotion['fear'] || 0);

        return Math.max(-1, Math.min(1, positive - negative));
    }

    /**
     * 批量编码
     */
    async encodeBatch(contexts: EncodingContext[]): Promise<Omit<MemoryRecord, 'id' | 'accessCount' | 'lastAccess'>[]> {
        const results: Omit<MemoryRecord, 'id' | 'accessCount' | 'lastAccess'>[] = [];
        for (const context of contexts) {
            results.push(await this.encode(context));
        }
        return results;
    }

    /**
     * 从核心记忆摘要创建语义记忆
     */
    async encodeSemanticMemory(
        summary: string,
        userId?: string,
        relatedMemoryIds?: string[]
    ): Promise<Omit<MemoryRecord, 'id' | 'accessCount' | 'lastAccess'>> {
        const embedding = await embeddingService.embed(summary);

        return {
            content: summary,
            embedding,
            timestamp: Date.now(),
            type: 'semantic',
            importance: 0.7, // 语义记忆默认较高重要性
            userId,
            emotionalValence: 0,
            metadata: {
                relatedMemoryIds,
                createdBy: 'reflection'
            }
        };
    }

    /**
     * 创建核心记忆 (最高优先级)
     */
    async encodeCoreMemory(
        insight: string,
        userId?: string
    ): Promise<Omit<MemoryRecord, 'id' | 'accessCount' | 'lastAccess'>> {
        const embedding = await embeddingService.embed(insight);

        return {
            content: insight,
            embedding,
            timestamp: Date.now(),
            type: 'core',
            importance: 0.9, // 核心记忆最高重要性
            userId,
            emotionalValence: 0,
            metadata: {
                createdBy: 'dreaming'
            }
        };
    }
}
