/**
 * Phase 2: 本地 Embedding 服务
 * 使用 @xenova/transformers 运行轻量级模型
 * 模型: bge-small-zh-v1.5 (中文优化) 或 all-MiniLM-L6-v2 (通用)
 */


export class EmbeddingService {
    private embedder: any = null;
    private modelName: string;
    private isInitializing: boolean = false;
    private initPromise: Promise<void> | null = null;

    constructor(modelName: string = 'Xenova/bge-small-zh-v1.5') {
        this.modelName = modelName;
    }

    /**
     * 懒加载初始化 Embedding 模型
     */
    async initialize(): Promise<void> {
        if (this.embedder) return;
        
        if (this.isInitializing && this.initPromise) {
            return this.initPromise;
        }

        this.isInitializing = true;
        this.initPromise = this._doInitialize();
        return this.initPromise;
    }

    private async _doInitialize(): Promise<void> {
        try {
            console.log(`🧠 [Embedding] Loading model: ${this.modelName}...`);
            const startTime = Date.now();
            
            const { pipeline } = await import('@xenova/transformers');
            this.embedder = await pipeline('feature-extraction', this.modelName, {
                quantized: true  // 使用量化版本，更快更小
            });
            
            const elapsed = Date.now() - startTime;
            console.log(`✅ [Embedding] Model loaded in ${elapsed}ms`);
        } catch (error: any) {
            console.error(`❌ [Embedding] Failed to load model: ${error.message}`);
            // 降级到简单的 TF-IDF 风格 embedding
            console.log('⚠️ [Embedding] Falling back to simple hash embedding');
            this.embedder = null;
        } finally {
            this.isInitializing = false;
        }
    }

    /**
     * 将文本转换为向量
     */
    async embed(text: string): Promise<number[]> {
        await this.initialize();

        if (this.embedder) {
            try {
                const output = await this.embedder(text, {
                    pooling: 'mean',
                    normalize: true
                });
                // output.data 是 Float32Array
                return Array.from(output.data as Float32Array);
            } catch (error: any) {
                console.error(`❌ [Embedding] Error: ${error.message}`);
                return this.fallbackEmbed(text);
            }
        }

        return this.fallbackEmbed(text);
    }

    /**
     * 批量 Embedding
     */
    async embedBatch(texts: string[]): Promise<number[][]> {
        // 串行处理，避免内存爆炸
        const results: number[][] = [];
        for (const text of texts) {
            results.push(await this.embed(text));
        }
        return results;
    }

    /**
     * 降级方案：简单的字符哈希 Embedding
     * 维度固定为 384 (与 bge-small 一致)
     */
    private fallbackEmbed(text: string): number[] {
        const dim = 384;
        const embedding = new Array(dim).fill(0);
        
        // 简单的字符级哈希
        for (let i = 0; i < text.length; i++) {
            const charCode = text.charCodeAt(i);
            const idx = (charCode * (i + 1)) % dim;
            embedding[idx] += 1;
        }

        // L2 归一化
        const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0)) || 1;
        return embedding.map(v => v / norm);
    }

    /**
     * 计算余弦相似度
     */
    static cosineSimilarity(a: number[], b: number[]): number {
        if (!a || !b || a.length !== b.length) return 0;
        
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        
        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        return denominator === 0 ? 0 : dotProduct / denominator;
    }

    /**
     * 简单词嵌入 (无需模型，快速计算)
     * 用于轻量级相似度计算场景
     * 
     * @param text 输入文本
     * @param dimensions 向量维度 (默认128)
     */
    static simpleEmbedding(text: string, dimensions: number = 128): number[] {
        const words = text.toLowerCase().split(/\s+/).filter(Boolean);
        const embedding = new Array(dimensions).fill(0);
        
        for (const word of words) {
            let hash = 0;
            for (let i = 0; i < word.length; i++) {
                hash = ((hash << 5) - hash) + word.charCodeAt(i);
                hash = hash & hash;
            }
            const idx = Math.abs(hash) % dimensions;
            embedding[idx] += 1;
        }
        
        // L2 归一化
        const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0)) || 1;
        return embedding.map(v => v / norm);
    }
}

// 单例导出
export const embeddingService = new EmbeddingService();
