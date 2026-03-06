/**
 * Memory-R1: 强化学习驱动的记忆管理
 * 
 * 核心思想：
 * - 让 AI 学会"记住什么"
 * - 通过用户反馈优化记忆策略
 * - 不更新模型权重，而是优化记忆选择策略
 * 
 * 状态: 当前记忆候选 + 上下文
 * 动作: store | compress | forget
 * 奖励: 用户反馈 + 对话质量
 */

import fs from 'fs';
import path from 'path';

const POLICY_PATH = process.env.MEMORY_R1_POLICY_PATH || path.resolve(process.cwd(), 'data/memory_r1/policy.json');
const HISTORY_PATH = process.env.MEMORY_R1_HISTORY_PATH || path.resolve(process.cwd(), 'data/memory_r1/history.jsonl');

export interface MemoryState {
    content: string;
    context: string;
    importance: number;
    recency: number;
    redundancy: number;
    userId?: string;
    source?: string;
}

export type MemoryAction = 'store' | 'compress' | 'forget';

export interface MemoryDecision {
    state: MemoryState;
    action: MemoryAction;
    timestamp: string;
    confidence: number;
}

export interface UserFeedback {
    positive: boolean;
    negative: boolean;
    repeated: boolean;
    helpful: boolean;
    quality?: number;
}

export interface PolicyWeights {
    importance: number;
    recency: number;
    redundancy: number;
    random: number;
    storeThreshold: number;
    compressThreshold: number;
}

interface HistoryRecord {
    timestamp: string;
    state: MemoryState;
    action: MemoryAction;
    reward: number;
    previousWeights: PolicyWeights;
    updatedWeights: PolicyWeights;
}

const DEFAULT_WEIGHTS: PolicyWeights = {
    importance: 0.35,
    recency: 0.25,
    redundancy: 0.25,
    random: 0.15,
    storeThreshold: 0.65,
    compressThreshold: 0.35,
};

export class MemoryR1 {
    private weights: PolicyWeights;
    private learningRate: number = 0.01;
    private history: HistoryRecord[] = [];
    private initialized: boolean = false;

    constructor() {
        this.weights = { ...DEFAULT_WEIGHTS };
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(POLICY_PATH)) {
                const data = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf-8'));
                this.weights = { ...DEFAULT_WEIGHTS, ...data.weights };
            }

            if (fs.existsSync(HISTORY_PATH)) {
                const content = fs.readFileSync(HISTORY_PATH, 'utf-8');
                this.history = content.split('\n').filter(Boolean).map(line => {
                    try {
                        return JSON.parse(line);
                    } catch {
                        return null;
                    }
                }).filter(Boolean) as HistoryRecord[];
            }

            this.initialized = true;
            console.log(`[MemoryR1] Loaded policy with weights:`, this.weights);
        } catch (err) {
            console.error('[MemoryR1] Load failed:', err);
            this.weights = { ...DEFAULT_WEIGHTS };
        }
    }

    private save(): void {
        try {
            const dir = path.dirname(POLICY_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(POLICY_PATH, JSON.stringify({
                weights: this.weights,
                updatedAt: new Date().toISOString(),
            }, null, 2), 'utf-8');
        } catch (err) {
            console.error('[MemoryR1] Save failed:', err);
        }
    }

    private saveHistory(record: HistoryRecord): void {
        try {
            const dir = path.dirname(HISTORY_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.appendFileSync(HISTORY_PATH, JSON.stringify(record) + '\n', 'utf-8');
            this.history.push(record);

            if (this.history.length > 1000) {
                this.history = this.history.slice(-500);
                fs.writeFileSync(HISTORY_PATH, this.history.map(h => JSON.stringify(h)).join('\n'), 'utf-8');
            }
        } catch (err) {
            console.error('[MemoryR1] Save history failed:', err);
        }
    }

    decide(state: MemoryState): MemoryDecision {
        const score = this.calculateScore(state);
        
        let action: MemoryAction;
        if (score >= this.weights.storeThreshold) {
            action = 'store';
        } else if (score >= this.weights.compressThreshold) {
            action = 'compress';
        } else {
            action = 'forget';
        }

        return {
            state,
            action,
            timestamp: new Date().toISOString(),
            confidence: score,
        };
    }

    private calculateScore(state: MemoryState): number {
        const randomFactor = Math.random() * this.weights.random;
        
        return (
            this.weights.importance * state.importance +
            this.weights.recency * state.recency -
            this.weights.redundancy * state.redundancy +
            randomFactor
        );
    }

    learn(state: MemoryState, action: MemoryAction, feedback: UserFeedback): void {
        const reward = this.calculateReward(feedback);
        
        if (reward === 0) return;

        const previousWeights = { ...this.weights };

        if (action === 'store') {
            if (reward > 0) {
                this.weights.importance = Math.min(1, this.weights.importance + this.learningRate * state.importance);
                this.weights.recency = Math.min(1, this.weights.recency + this.learningRate * state.recency);
            } else {
                this.weights.redundancy = Math.min(1, this.weights.redundancy + this.learningRate * 0.5);
            }
        } else if (action === 'compress') {
            if (reward > 0) {
                this.weights.compressThreshold = Math.max(0.2, this.weights.compressThreshold - this.learningRate * 0.1);
            }
        } else if (action === 'forget') {
            if (reward < 0) {
                this.weights.storeThreshold = Math.max(0.4, this.weights.storeThreshold - this.learningRate * 0.1);
            }
        }

        this.normalizeWeights();
        this.save();

        const record: HistoryRecord = {
            timestamp: new Date().toISOString(),
            state,
            action,
            reward,
            previousWeights,
            updatedWeights: { ...this.weights },
        };

        this.saveHistory(record);
        console.log(`[MemoryR1] Learned from feedback: action=${action}, reward=${reward.toFixed(2)}`);
    }

    private calculateReward(feedback: UserFeedback): number {
        let reward = 0;

        if (feedback.positive) reward += 1.0;
        if (feedback.negative) reward -= 1.0;
        if (feedback.repeated) reward -= 0.5;
        if (feedback.helpful) reward += 0.5;
        if (feedback.quality !== undefined) {
            reward += (feedback.quality - 0.5) * 0.5;
        }

        return reward;
    }

    private normalizeWeights(): void {
        const total = this.weights.importance + this.weights.recency + this.weights.redundancy + this.weights.random;
        if (total > 0) {
            this.weights.importance /= total;
            this.weights.recency /= total;
            this.weights.redundancy /= total;
            this.weights.random /= total;
        }
    }

    estimateImportance(content: string): number {
        const importantKeywords = [
            '喜欢', '爱', '重要', '记住', '记得', '不要忘',
            '生日', '名字', '地址', '电话', '密码',
            '过敏', '疾病', '药物',
        ];

        let score = 0.3;

        for (const keyword of importantKeywords) {
            if (content.includes(keyword)) {
                score += 0.15;
            }
        }

        if (content.length > 100) score += 0.1;
        if (content.includes('!') || content.includes('！')) score += 0.05;

        return Math.min(1, score);
    }

    estimateRedundancy(content: string, existingContents: string[] = []): number {
        if (existingContents.length === 0) return 0;

        const words = new Set(content.toLowerCase().split(/\s+/));
        let maxOverlap = 0;

        for (const existing of existingContents) {
            const existingWords = new Set(existing.toLowerCase().split(/\s+/));
            const intersection = new Set([...words].filter(w => existingWords.has(w)));
            const overlap = intersection.size / Math.max(words.size, existingWords.size);
            maxOverlap = Math.max(maxOverlap, overlap);
        }

        return maxOverlap;
    }

    getWeights(): PolicyWeights {
        return { ...this.weights };
    }

    setWeights(weights: Partial<PolicyWeights>): void {
        this.weights = { ...this.weights, ...weights };
        this.normalizeWeights();
        this.save();
    }

    getStats(): {
        initialized: boolean;
        weights: PolicyWeights;
        historyCount: number;
        learningRate: number;
    } {
        return {
            initialized: this.initialized,
            weights: this.getWeights(),
            historyCount: this.history.length,
            learningRate: this.learningRate,
        };
    }

    reset(): void {
        this.weights = { ...DEFAULT_WEIGHTS };
        this.history = [];
        this.save();
        console.log('[MemoryR1] Policy reset to defaults');
    }
}

let instance: MemoryR1 | null = null;

export function getMemoryR1(): MemoryR1 {
    if (!instance) {
        instance = new MemoryR1();
    }
    return instance;
}
