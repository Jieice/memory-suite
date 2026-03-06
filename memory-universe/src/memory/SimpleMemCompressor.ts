import { MemorySearchResult } from './types';

export interface SimpleMemOptions {
    maxTokens?: number;
    similarityThreshold?: number;
}

export class SimpleMemCompressor {
    private maxTokens: number;
    private similarityThreshold: number;

    constructor(options: SimpleMemOptions = {}) {
        this.maxTokens = options.maxTokens || 550;
        this.similarityThreshold = options.similarityThreshold || 0.85;
    }

    /**
     * 30x efficient memory compression pipeline
     * 1. Redundancy Filtering (Semantic Deduplication)
     * 2. Dynamic Depth Adjustment (Token Budgeting)
     */
    public compress(results: MemorySearchResult[]): MemorySearchResult[] {
        if (!results || results.length === 0) return [];

        // 1. Filter Redundant (Semantic Deduplication)
        const unique = this.filterRedundant(results);

        // 2. Dynamic Depth Adjustment (Token Budgeting)
        const compressed = this.adjustDepth(unique);

        return compressed;
    }

    private filterRedundant(results: MemorySearchResult[]): MemorySearchResult[] {
        const kept: MemorySearchResult[] = [];

        // Sort by relevance desending to keep most relevant redundant items
        const sorted = [...results].sort((a, b) => b.relevance - a.relevance);

        for (const item of sorted) {
            let isRedundant = false;
            for (const k of kept) {
                // Calculate similarity between memories (embedding based)
                const sim = this.calculateSimilarity(item.memory.embedding, k.memory.embedding);
                if (sim > this.similarityThreshold) {
                    isRedundant = true;
                    break;
                }
            }
            if (!isRedundant) {
                kept.push(item);
            }
        }
        return kept;
    }

    private adjustDepth(results: MemorySearchResult[]): MemorySearchResult[] {
        let currentTokens = 0;
        const selected: MemorySearchResult[] = [];

        for (const item of results) {
            const tokens = this.estimateTokens(item.memory.content);
            if (currentTokens + tokens > this.maxTokens) {
                // If this is a very high relevance item, maybe we should try to fit it?
                // For SimpleMem, we just cut off to strictly respect budget.
                continue; 
            }
            selected.push(item);
            currentTokens += tokens;
        }

        return selected;
    }

    private calculateSimilarity(a: number[], b: number[]): number {
        if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        return dot / ((Math.sqrt(normA) * Math.sqrt(normB)) || 1);
    }

    private estimateTokens(text: string): number {
        // Simple approximation: 1 token ~= 1.5 chinese chars or 3 english chars
        // Using a conservative estimate
        return Math.ceil(text.length * 0.7); 
    }
}
