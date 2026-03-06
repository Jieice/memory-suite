/**
 * Mem0 式记忆层
 * 
 * 基于 Mem0 开源项目 (43K stars)
 * 
 * 核心思想：
 * - 轻量级"记忆层"，即插即用
 * - 自动提取关键事实，token 成本降低 80-90%
 * - 响应质量提升 26%
 * 
 * 与传统记忆的区别：
 * - 不是存储原始对话，而是提取"事实"
 * - 事实是结构化的、可更新的
 * - 支持增量更新而非重复存储
 */

import fs from 'fs';
import path from 'path';
import { EmbeddingService } from './EmbeddingService';

const FACTS_PATH = process.env.MEM0_FACTS_PATH || path.resolve(process.cwd(), 'data/mem0_facts/facts.jsonl');

interface Fact {
    id: string;
    userId: string;
    content: string;
    category: 'preference' | 'event' | 'relationship' | 'knowledge' | 'trait';
    confidence: number;
    source: string;
    createdAt: string;
    updatedAt: string;
    accessCount: number;
    embedding?: number[];
}

interface FactExtractionResult {
    facts: string[];
    category: Fact['category'];
}

const EXTRACTION_PROMPT = `从以下对话中提取关键事实。只提取客观、可验证的信息，忽略主观感受和临时状态。

对话内容：
用户: {user_input}
助手: {assistant_response}

请提取 1-3 个关键事实，每个事实一行，格式：
- 偏好类: "用户喜欢/不喜欢..."
- 事件类: "用户曾经..."
- 关系类: "用户与...的关系是..."
- 特征类: "用户是..."

只输出事实，不要其他解释。`;

const FACT_PATTERNS = {
    preference: [
        /喜欢|爱|偏好|最爱|比较喜欢|更爱/i,
        /不喜欢|讨厌|反感|厌恶/i,
        /想|想要|希望|期待/i,
    ],
    event: [
        /昨天|今天|刚才|之前|上次|曾经/i,
        /去了|做了|买了|看了|玩了/i,
        /发生|遇到|经历/i,
    ],
    relationship: [
        /朋友|家人|同事|同学|粉丝/i,
        /认识|熟悉|陌生/i,
        /关系|感情/i,
    ],
    trait: [
        /我是|我是做|我工作|我学/i,
        /性格|特点|习惯/i,
    ],
};

function generateId(): string {
    return `fact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function detectCategory(text: string): Fact['category'] {
    for (const [category, patterns] of Object.entries(FACT_PATTERNS)) {
        for (const pattern of patterns) {
            if (pattern.test(text)) {
                return category as Fact['category'];
            }
        }
    }
    return 'knowledge';
}

function extractFactsLocally(userInput: string, assistantResponse: string): FactExtractionResult[] {
    const results: FactExtractionResult[] = [];
    
    const sentences = userInput.split(/[。！？，,]/).filter(s => s.trim().length > 3);
    
    for (const sentence of sentences) {
        const category = detectCategory(sentence);
        
        if (category !== 'knowledge' || sentence.includes('我')) {
            let fact = sentence.trim();
            
            if (!fact.startsWith('用户')) {
                fact = `用户${fact.replace(/^我/, '')}`;
            }
            
            results.push({
                facts: [fact],
                category,
            });
        }
    }
    
    return results;
}

class Mem0StyleMemory {
    private facts: Fact[] = [];
    private initialized: boolean = false;

    constructor() {
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(FACTS_PATH)) {
                const content = fs.readFileSync(FACTS_PATH, 'utf-8');
                this.facts = content.split('\n').filter(Boolean).map(line => {
                    try {
                        return JSON.parse(line);
                    } catch {
                        return null;
                    }
                }).filter(Boolean) as Fact[];
            }
            this.initialized = true;
            console.log(`[Mem0] 加载 ${this.facts.length} 条事实`);
        } catch (err) {
            console.error('[Mem0] 加载失败:', err);
            this.facts = [];
        }
    }

    private save(): void {
        try {
            const dir = path.dirname(FACTS_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const lines = this.facts.map(f => JSON.stringify(f)).join('\n');
            fs.writeFileSync(FACTS_PATH, lines, 'utf-8');
        } catch (err) {
            console.error('[Mem0] 保存失败:', err);
        }
    }

    async add(userInput: string, assistantResponse: string, userId: string = 'default'): Promise<Fact[]> {
        const extractions = extractFactsLocally(userInput, assistantResponse);
        const addedFacts: Fact[] = [];

        for (const extraction of extractions) {
            for (const factContent of extraction.facts) {
                const embedding = EmbeddingService.simpleEmbedding(factContent);
                
                const existing = this.findSimilarFact(factContent, userId, 0.9);
                
                if (existing) {
                    existing.updatedAt = new Date().toISOString();
                    existing.accessCount++;
                    existing.embedding = embedding;
                    console.log(`[Mem0] 更新事实: ${factContent.slice(0, 50)}...`);
                } else {
                    const fact: Fact = {
                        id: generateId(),
                        userId,
                        content: factContent,
                        category: extraction.category,
                        confidence: 0.8,
                        source: userInput.slice(0, 100),
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        accessCount: 1,
                        embedding,
                    };
                    this.facts.push(fact);
                    addedFacts.push(fact);
                    console.log(`[Mem0] 新增事实: ${factContent.slice(0, 50)}...`);
                }
            }
        }

        this.save();
        return addedFacts;
    }

    private findSimilarFact(content: string, userId: string, threshold: number): Fact | null {
        const embedding = EmbeddingService.simpleEmbedding(content);
        
        for (const fact of this.facts) {
            if (fact.userId !== userId) continue;
            
            const similarity = EmbeddingService.cosineSimilarity(embedding, fact.embedding || []);
            if (similarity > threshold) {
                return fact;
            }
        }
        
        return null;
    }

    search(query: string, userId: string = 'default', limit: number = 10): Fact[] {
        const queryEmbedding = EmbeddingService.simpleEmbedding(query);
        
        const scored = this.facts
            .filter(f => f.userId === userId)
            .map(f => ({
                fact: f,
                score: EmbeddingService.cosineSimilarity(queryEmbedding, f.embedding || []),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        for (const { fact } of scored) {
            fact.accessCount++;
        }

        this.save();
        return scored.map(s => s.fact);
    }

    getAll(userId?: string): Fact[] {
        if (userId) {
            return this.facts.filter(f => f.userId === userId);
        }
        return this.facts;
    }

    getByCategory(category: Fact['category'], userId?: string): Fact[] {
        return this.facts.filter(f => 
            f.category === category && 
            (!userId || f.userId === userId)
        );
    }

    delete(factId: string): boolean {
        const idx = this.facts.findIndex(f => f.id === factId);
        if (idx >= 0) {
            this.facts.splice(idx, 1);
            this.save();
            return true;
        }
        return false;
    }

    formatForPrompt(facts: Fact[]): string {
        if (facts.length === 0) return '';
        
        const byCategory = new Map<Fact['category'], Fact[]>();
        for (const fact of facts) {
            if (!byCategory.has(fact.category)) {
                byCategory.set(fact.category, []);
            }
            byCategory.get(fact.category)!.push(fact);
        }
        
        const lines = ['## 用户记忆'];
        
        const categoryNames: Record<Fact['category'], string> = {
            preference: '偏好',
            event: '经历',
            relationship: '关系',
            knowledge: '知识',
            trait: '特征',
        };
        
        for (const [category, categoryFacts] of byCategory) {
            lines.push(`\n### ${categoryNames[category]}`);
            for (const fact of categoryFacts.slice(0, 5)) {
                lines.push(`- ${fact.content}`);
            }
        }
        
        return lines.join('\n');
    }

    getStats(): {
        totalFacts: number;
        byCategory: Record<string, number>;
        avgAccessCount: number;
    } {
        const byCategory: Record<string, number> = {};
        for (const fact of this.facts) {
            byCategory[fact.category] = (byCategory[fact.category] || 0) + 1;
        }
        
        return {
            totalFacts: this.facts.length,
            byCategory,
            avgAccessCount: this.facts.length > 0
                ? this.facts.reduce((a, f) => a + f.accessCount, 0) / this.facts.length
                : 0,
        };
    }
}

let instance: Mem0StyleMemory | null = null;

export function getMem0(): Mem0StyleMemory {
    if (!instance) {
        instance = new Mem0StyleMemory();
    }
    return instance;
}

export { Mem0StyleMemory, Fact };
