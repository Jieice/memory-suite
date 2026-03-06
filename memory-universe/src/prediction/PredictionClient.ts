/**
 * Prediction Client - 预测引擎客户端
 * 与 Prediction Engine (4013) 通信，提供预测能力
 */

import axios, { AxiosInstance } from 'axios';

export interface PredictionResult {
    expected_interaction_rate: number;
    expected_positive_rate: number;
    risk_level: 'low' | 'medium' | 'high';
    risk_factors: string[];
    recommendations: string[];
    confidence: number;
}

export interface SentimentPrediction {
    timeline: Array<{
        minute: number;
        average_sentiment: number;
        active_agents: number;
    }>;
    risk_analysis: {
        final_sentiment: number;
        trend: string;
        risk_level: string;
    };
    recommendations: string[];
}

export interface StrategyOptimization {
    goal: string;
    optimal_strategy: {
        name: string;
        actions: string[];
        expected_outcome: Record<string, any>;
    };
    confidence: number;
}

export class PredictionClient {
    private client: AxiosInstance;
    private enabled: boolean;
    private cache: Map<string, { result: any; timestamp: number }>;
    private cacheTTL: number;
    private strict: boolean;
    private minInteractionRate: number;
    private minPositiveRate: number;
    private minConfidence: number;

    constructor() {
        const predictionPort = process.env.PREDICTION_ENGINE_PORT || '4013';
        const baseURL = process.env.PREDICTION_ENGINE_URL || `http://localhost:${predictionPort}`;
        this.enabled = process.env.PREDICTION_ENABLED !== 'false';
        this.cacheTTL = parseInt(process.env.PREDICTION_CACHE_TTL || '300') * 1000; // 转换为毫秒
        this.strict = process.env.PREDICTION_STRICT === 'true';
        this.minInteractionRate = this.clampRate(parseFloat(process.env.PREDICTION_MIN_INTERACTION_RATE || '0.2'));
        this.minPositiveRate = this.clampRate(parseFloat(process.env.PREDICTION_MIN_POSITIVE_RATE || '0.2'));
        this.minConfidence = this.clampRate(parseFloat(process.env.PREDICTION_MIN_CONFIDENCE || '0.6'));

        this.client = axios.create({
            baseURL,
            timeout: 15000, // 增加到15秒，给 Prediction Engine 足够的启动时间
            headers: {
                'Content-Type': 'application/json'
            }
        });

        this.cache = new Map();

        console.log(`[PredictionClient] Initialized: ${this.enabled ? 'Enabled' : 'Disabled'}`);
        console.log(`[PredictionClient] URL: ${baseURL}`);
    }

    /**
     * 检查服务健康状态（带重试）
     * 注意：此方法不会抛出异常，而是返回 false 并禁用预测功能
     */
    async checkHealth(retries: number = 10, delayMs: number = 3000): Promise<boolean> {
        if (!this.enabled) return false;

        console.log(`[PredictionClient] Starting health check with ${retries} retries, ${delayMs}ms delay between attempts`);

        for (let i = 0; i < retries; i++) {
            try {
                const response = await this.client.get('/health', { timeout: 15000 });
                if (response.data.status === 'healthy') {
                    console.log('[PredictionClient] ✅ Health check passed, prediction engine is ready');
                    return true;
                }
            } catch (error: any) {
                const errorMsg = error.code || error.message || 'Unknown error';
                if (i < retries - 1) {
                    console.log(`[PredictionClient] ⏳ Health check attempt ${i + 1}/${retries} failed (${errorMsg}), retrying in ${delayMs}ms...`);
                    await this.sleep(delayMs);
                } else {
                    console.warn(`[PredictionClient] ❌ Health check failed after ${retries} attempts: ${errorMsg}`);
                }
            }
        }

        // 降级：禁用预测，避免后续请求报错
        this.enabled = false;
        console.warn('[PredictionClient] ⚠️ Disabled after health check failure, prediction features will be skipped');
        return false;
    }

    /**
     * 预测互动效果
     */
    async predictInteraction(
        content: string,
        context: Record<string, any> = {}
    ): Promise<PredictionResult | null> {
        if (!this.enabled) return null;

        // 检查缓存
        const cacheKey = `interaction_${this.hashContent(content)}`;
        const cached = this.getFromCache(cacheKey);
        if (cached) {
            console.log('[PredictionClient] Cache hit for interaction prediction');
            return cached;
        }

        try {
            const response = await this.client.post('/predict/interaction', {
                content,
                context
            });

            const result = response.data.prediction;
            this.setCache(cacheKey, result);
            
            console.log(`[PredictionClient] Predicted: ${content.slice(0, 30)}... | Risk: ${result.risk_level} | Rate: ${(result.expected_interaction_rate * 100).toFixed(1)}%`);
            
            return result;
        } catch (error: any) {
            console.error('[PredictionClient] Prediction failed:', error.message);
            return null;
        }
    }

    /**
     * 预测舆情演化
     */
    async predictSentiment(
        scenario: string,
        duration: number = 5
    ): Promise<SentimentPrediction | null> {
        if (!this.enabled) return null;

        try {
            const response = await this.client.post('/predict/sentiment', {
                scenario,
                duration
            });

            return response.data.prediction;
        } catch (error: any) {
            console.error('[PredictionClient] Sentiment prediction failed:', error.message);
            return null;
        }
    }

    /**
     * 优化策略
     */
    async optimizeStrategy(
        goal: string,
        constraints: string[] = []
    ): Promise<StrategyOptimization | null> {
        if (!this.enabled) return null;

        try {
            const response = await this.client.post('/predict/optimize', {
                goal,
                constraints
            });

            return response.data.optimization;
        } catch (error: any) {
            console.error('[PredictionClient] Strategy optimization failed:', error.message);
            return null;
        }
    }

    /**
     * 判断是否应该说这句话（风险评估）
     */
    async shouldSayThis(
        content: string,
        context: Record<string, any> = {}
    ): Promise<{ allowed: boolean; reason?: string; alternative?: string }> {
        if (!this.enabled) {
            return { allowed: true }; // 降级：允许
        }

        const prediction = await this.predictInteraction(content, context);

        if (!prediction) {
            return { allowed: true }; // 降级：允许
        }

        const recommendation = prediction.recommendations?.[0] || 'Consider adjusting the topic or tone.';
        const highRisk = prediction.risk_level === 'high' && prediction.confidence >= this.minConfidence;
        if (highRisk) {
            console.warn(`[PredictionClient] High risk detected: ${content.slice(0, 50)}...`);
            if (this.strict) {
                return {
                    allowed: false,
                    reason: `High risk: ${prediction.risk_factors.join(', ')}`,
                    alternative: recommendation
                };
            }
        }

        const lowInteraction = prediction.expected_interaction_rate < this.minInteractionRate;
        if (lowInteraction) {
            console.warn(`[PredictionClient] Low interaction expected: ${(prediction.expected_interaction_rate * 100).toFixed(1)}%`);
            if (this.strict) {
                return {
                    allowed: false,
                    reason: `Low interaction expected (${(prediction.expected_interaction_rate * 100).toFixed(1)}%)`,
                    alternative: recommendation
                };
            }
        }

        const lowPositive = prediction.expected_positive_rate < this.minPositiveRate;
        if (lowPositive) {
            console.warn(`[PredictionClient] Low positive rate expected: ${(prediction.expected_positive_rate * 100).toFixed(1)}%`);
            if (this.strict) {
                return {
                    allowed: false,
                    reason: `Low positive rate expected (${(prediction.expected_positive_rate * 100).toFixed(1)}%)`,
                    alternative: recommendation
                };
            }
        }

        return { allowed: true };
    }

    /**
     * 从多个候选中选择最优话题
     */
    async selectBestTopic(
        candidates: string[],
        context: Record<string, any> = {}
    ): Promise<{ topic: string; score: number; prediction: PredictionResult | null }> {
        if (!this.enabled || candidates.length === 0) {
            return {
                topic: candidates[0] || '',
                score: 0.5,
                prediction: null
            };
        }

        let bestTopic = candidates[0];
        let bestScore = 0;
        let bestPrediction: PredictionResult | null = null;

        for (const topic of candidates) {
            const prediction = await this.predictInteraction(topic, context);
            
            if (prediction) {
                const score = prediction.expected_interaction_rate;
                
                if (score > bestScore && prediction.risk_level !== 'high') {
                    bestScore = score;
                    bestTopic = topic;
                    bestPrediction = prediction;
                }
            }

            // 避免请求过快
            await this.sleep(100);
        }

        console.log(`[PredictionClient] Best topic: ${bestTopic} (score: ${(bestScore * 100).toFixed(1)}%)`);

        return {
            topic: bestTopic,
            score: bestScore,
            prediction: bestPrediction
        };
    }

    /**
     * 获取预测引擎状态
     */
    async getState(): Promise<any> {
        if (!this.enabled) return null;

        try {
            const response = await this.client.get('/state');
            return response.data;
        } catch (error) {
            return null;
        }
    }

    // ========== 私有方法 ==========

    private hashContent(content: string): string {
        // 简单哈希函数
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(36);
    }

    private getFromCache(key: string): any | null {
        const cached = this.cache.get(key);
        if (!cached) return null;

        const now = Date.now();
        if (now - cached.timestamp > this.cacheTTL) {
            this.cache.delete(key);
            return null;
        }

        return cached.result;
    }

    private setCache(key: string, result: any): void {
        this.cache.set(key, {
            result,
            timestamp: Date.now()
        });

        // 清理过期缓存
        if (this.cache.size > 100) {
            const now = Date.now();
            for (const [k, v] of this.cache.entries()) {
                if (now - v.timestamp > this.cacheTTL) {
                    this.cache.delete(k);
                }
            }
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private clampRate(value: number): number {
        if (!Number.isFinite(value)) {
            return 0;
        }
        return Math.max(0, Math.min(1, value));
    }
}

// 单例导出
export const predictionClient = new PredictionClient();
