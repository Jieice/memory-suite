/**
 * Evo-Memory: 自演化记忆系统
 * 
 * 基于 2024-2025 论文 "Evo-Memory: Benchmarking LLM Agent Test-time Learning"
 * 
 * 核心区别：
 * - Reflection = 修正当前任务的推理错误（短期）
 * - Experience Reuse = 从过去任务抽象通用经验（长期学习）
 * 
 * 关键创新：Refine Memory 步骤
 * - 删除噪声/失败经验
 * - 合并相似任务
 * - 抽象可复用策略
 */

import fs from 'fs';
import path from 'path';
import { EmbeddingService } from './EmbeddingService';

const EXPERIENCE_PATH = process.env.EVO_MEMORY_PATH || path.resolve(process.cwd(), 'data/evo_memory/experiences.jsonl');
const STRATEGY_PATH = process.env.EVO_STRATEGY_PATH || path.resolve(process.cwd(), 'data/evo_memory/strategies.json');

const MIN_SUCCESS_REUSE = 2;
const MAX_FAILURE_KEEP = 3;
const SIMILARITY_THRESHOLD = 0.85;

interface Experience {
    id: string;
    timestamp: string;
    input: string;
    output: string;
    feedback: 'success' | 'failure' | 'neutral';
    context?: {
        userId?: string;
        route?: 'fast' | 'slow';
        latencyMs?: number;
        topics?: string[];
    };
    abstractedStrategy?: string;
    reuseCount: number;
    lastReuse: number;
    embedding?: number[];
}

interface Strategy {
    id: string;
    pattern: string;
    guidance: string;
    successRate: number;
    sampleCount: number;
    examples: string[];
    createdAt: string;
    lastUpdated: string;
}

interface RefineResult {
    removed: number;
    merged: number;
    abstracted: number;
    totalBefore: number;
    totalAfter: number;
}

function generateId(): string {
    return `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

class EvoMemorySystem {
    private experiences: Experience[] = [];
    private strategies: Strategy[] = [];
    private initialized: boolean = false;

    constructor() {
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(EXPERIENCE_PATH)) {
                const content = fs.readFileSync(EXPERIENCE_PATH, 'utf-8');
                this.experiences = content.split('\n').filter(Boolean).map(line => {
                    try {
                        return JSON.parse(line);
                    } catch {
                        return null;
                    }
                }).filter(Boolean) as Experience[];
            }

            if (fs.existsSync(STRATEGY_PATH)) {
                const content = fs.readFileSync(STRATEGY_PATH, 'utf-8');
                this.strategies = JSON.parse(content);
            }

            this.initialized = true;
            console.log(`[EvoMemory] 加载 ${this.experiences.length} 条经验, ${this.strategies.length} 条策略`);
        } catch (err) {
            console.error('[EvoMemory] 加载失败:', err);
            this.experiences = [];
            this.strategies = [];
        }
    }

    private save(): void {
        try {
            const dir = path.dirname(EXPERIENCE_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const lines = this.experiences.map(e => JSON.stringify(e)).join('\n');
            fs.writeFileSync(EXPERIENCE_PATH, lines, 'utf-8');

            fs.writeFileSync(STRATEGY_PATH, JSON.stringify(this.strategies, null, 2), 'utf-8');
        } catch (err) {
            console.error('[EvoMemory] 保存失败:', err);
        }
    }

    addExperience(
        input: string,
        output: string,
        feedback: 'success' | 'failure' | 'neutral',
        context?: Experience['context']
    ): Experience {
        const embedding = EmbeddingService.simpleEmbedding(input);
        
        const exp: Experience = {
            id: generateId(),
            timestamp: new Date().toISOString(),
            input,
            output,
            feedback,
            context,
            reuseCount: 0,
            lastReuse: Date.now(),
            embedding,
        };

        this.experiences.push(exp);
        this.save();

        console.log(`[EvoMemory] 添加经验: ${feedback} | ${input.slice(0, 50)}...`);
        return exp;
    }

    retrieveRelevantExperience(query: string, limit: number = 5): Experience[] {
        const queryEmbedding = EmbeddingService.simpleEmbedding(query);

        const scored = this.experiences
            .filter(e => e.feedback === 'success' && e.embedding)
            .map(e => ({
                exp: e,
                score: EmbeddingService.cosineSimilarity(queryEmbedding, e.embedding || []),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        for (const { exp } of scored) {
            exp.reuseCount++;
            exp.lastReuse = Date.now();
        }

        this.save();
        return scored.map(s => s.exp);
    }

    async refineMemory(): Promise<RefineResult> {
        console.log('[EvoMemory] 开始 Refine Memory...');
        
        const before = this.experiences.length;
        let removed = 0, merged = 0, abstracted = 0;

        const failures = this.experiences.filter(e => e.feedback === 'failure');
        const failuresByInput = new Map<string, Experience[]>();
        
        for (const f of failures) {
            const key = f.input.slice(0, 50);
            if (!failuresByInput.has(key)) {
                failuresByInput.set(key, []);
            }
            failuresByInput.get(key)!.push(f);
        }

        for (const [, group] of failuresByInput) {
            if (group.length > MAX_FAILURE_KEEP) {
                const toRemove = group.slice(0, group.length - MAX_FAILURE_KEEP);
                for (const exp of toRemove) {
                    const idx = this.experiences.findIndex(e => e.id === exp.id);
                    if (idx >= 0) {
                        this.experiences.splice(idx, 1);
                        removed++;
                    }
                }
            }
        }

        const successes = this.experiences.filter(e => e.feedback === 'success');
        const similarityGroups: Experience[][] = [];

        for (const exp of successes) {
            let foundGroup = false;
            for (const group of similarityGroups) {
                if (group[0] && EmbeddingService.cosineSimilarity(exp.embedding || [], group[0].embedding || []) > SIMILARITY_THRESHOLD) {
                    group.push(exp);
                    foundGroup = true;
                    break;
                }
            }
            if (!foundGroup) {
                similarityGroups.push([exp]);
            }
        }

        for (const group of similarityGroups) {
            if (group.length >= MIN_SUCCESS_REUSE) {
                const representative = group.reduce((a, b) => 
                    (a.reuseCount > b.reuseCount) ? a : b
                );
                
                const toMerge = group.filter(e => e.id !== representative.id);
                for (const exp of toMerge) {
                    const idx = this.experiences.findIndex(e => e.id === exp.id);
                    if (idx >= 0) {
                        this.experiences.splice(idx, 1);
                        merged++;
                    }
                }

                if (!representative.abstractedStrategy) {
                    representative.abstractedStrategy = this.abstractStrategy(group);
                    abstracted++;
                }
            }
        }

        const newStrategies = this.extractStrategies();
        this.strategies = [...this.strategies, ...newStrategies];

        this.save();

        const result: RefineResult = {
            removed,
            merged,
            abstracted,
            totalBefore: before,
            totalAfter: this.experiences.length,
        };

        console.log(`[EvoMemory] Refine 完成: ${JSON.stringify(result)}`);
        return result;
    }

    private abstractStrategy(experiences: Experience[]): string {
        const inputs = experiences.map(e => e.input);
        const outputs = experiences.map(e => e.output);
        
        const commonPatterns: string[] = [];
        const words = inputs[0]?.toLowerCase().split(/\s+/) || [];
        
        for (const word of words) {
            if (word.length < 2) continue;
            const appearsInAll = inputs.every(input => 
                input.toLowerCase().includes(word)
            );
            if (appearsInAll) {
                commonPatterns.push(word);
            }
        }

        if (commonPatterns.length > 0) {
            return `针对包含 "${commonPatterns.slice(0, 3).join(', ')}" 的输入，采用类似回复策略`;
        }

        return `基于 ${experiences.length} 次成功经验的通用策略`;
    }

    private extractStrategies(): Strategy[] {
        const newStrategies: Strategy[] = [];
        
        const successes = this.experiences.filter(e => 
            e.feedback === 'success' && 
            e.abstractedStrategy && 
            e.reuseCount >= MIN_SUCCESS_REUSE
        );

        const byPattern = new Map<string, Experience[]>();
        for (const exp of successes) {
            const pattern = exp.abstractedStrategy || 'general';
            if (!byPattern.has(pattern)) {
                byPattern.set(pattern, []);
            }
            byPattern.get(pattern)!.push(exp);
        }

        for (const [pattern, group] of byPattern) {
            const existingStrategy = this.strategies.find(s => s.pattern === pattern);
            if (!existingStrategy && group.length >= 2) {
                newStrategies.push({
                    id: `strat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    pattern,
                    guidance: pattern,
                    successRate: 1.0,
                    sampleCount: group.length,
                    examples: group.slice(0, 3).map(e => e.output.slice(0, 100)),
                    createdAt: new Date().toISOString(),
                    lastUpdated: new Date().toISOString(),
                });
            }
        }

        return newStrategies;
    }

    getStrategies(): Strategy[] {
        return this.strategies;
    }

    getStats(): {
        totalExperiences: number;
        successCount: number;
        failureCount: number;
        strategyCount: number;
        avgReuseCount: number;
    } {
        return {
            totalExperiences: this.experiences.length,
            successCount: this.experiences.filter(e => e.feedback === 'success').length,
            failureCount: this.experiences.filter(e => e.feedback === 'failure').length,
            strategyCount: this.strategies.length,
            avgReuseCount: this.experiences.length > 0
                ? this.experiences.reduce((a, e) => a + e.reuseCount, 0) / this.experiences.length
                : 0,
        };
    }

    formatForPrompt(experiences: Experience[]): string {
        if (experiences.length === 0) return '';
        
        const lines = ['## 相关成功经验'];
        for (const exp of experiences.slice(0, 3)) {
            lines.push(`- 输入: "${exp.input.slice(0, 50)}..."`);
            lines.push(`  成功回复: "${exp.output.slice(0, 100)}..."`);
            if (exp.abstractedStrategy) {
                lines.push(`  策略: ${exp.abstractedStrategy}`);
            }
        }
        return lines.join('\n');
    }
}

let instance: EvoMemorySystem | null = null;

export function getEvoMemory(): EvoMemorySystem {
    if (!instance) {
        instance = new EvoMemorySystem();
    }
    return instance;
}

export { EvoMemorySystem, Experience, Strategy, RefineResult };
