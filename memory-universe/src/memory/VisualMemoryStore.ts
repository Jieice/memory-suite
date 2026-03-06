/**
 * Visual Memory Store - 视觉记忆存储
 * 
 * 存储和管理视觉记忆，支持：
 * - 图像描述存储
 * - 场景变化追踪
 * - 视觉记忆检索
 */

import fs from 'fs';
import path from 'path';
import { VisionResult } from './VisionService';
import { EmbeddingService } from './EmbeddingService';

const STORE_PATH = process.env.VISUAL_MEMORY_PATH || path.resolve(process.cwd(), 'data/visual_memory/memories.jsonl');

export interface VisualMemory {
    id: string;
    timestamp: string;
    imageHash: string;
    description: string;
    objects: string[];
    scene: string;
    confidence: number;
    embedding?: number[];
    metadata?: {
        source?: string;
        gameId?: string;
        tags?: string[];
    };
}

export interface SceneSummary {
    scene: string;
    firstSeen: string;
    lastSeen: string;
    count: number;
    avgConfidence: number;
}

function generateId(): string {
    return `vis_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class VisualMemoryStore {
    private memories: VisualMemory[] = [];
    private initialized: boolean = false;

    constructor() {
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(STORE_PATH)) {
                const content = fs.readFileSync(STORE_PATH, 'utf-8');
                this.memories = content.split('\n').filter(Boolean).map(line => {
                    try {
                        return JSON.parse(line);
                    } catch {
                        return null;
                    }
                }).filter(Boolean) as VisualMemory[];
            }
            this.initialized = true;
            console.log(`[VisualMemory] Loaded ${this.memories.length} visual memories`);
        } catch (err) {
            console.error('[VisualMemory] Load failed:', err);
            this.memories = [];
        }
    }

    private save(): void {
        try {
            const dir = path.dirname(STORE_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const lines = this.memories.map(m => JSON.stringify(m)).join('\n');
            fs.writeFileSync(STORE_PATH, lines, 'utf-8');
        } catch (err) {
            console.error('[VisualMemory] Save failed:', err);
        }
    }

    async store(result: VisionResult, metadata?: VisualMemory['metadata']): Promise<VisualMemory> {
        const embedding = EmbeddingService.simpleEmbedding(result.description);
        
        const memory: VisualMemory = {
            id: generateId(),
            timestamp: result.timestamp,
            imageHash: result.imageHash || '',
            description: result.description,
            objects: result.objects,
            scene: result.scene,
            confidence: result.confidence,
            embedding,
            metadata,
        };

        const existing = this.memories.find(m => m.imageHash === memory.imageHash);
        if (existing) {
            existing.timestamp = memory.timestamp;
            existing.confidence = Math.max(existing.confidence, memory.confidence);
            this.save();
            return existing;
        }

        this.memories.push(memory);
        this.save();
        
        console.log(`[VisualMemory] Stored: ${memory.description.slice(0, 50)}...`);
        return memory;
    }

    search(query: string, limit: number = 5): VisualMemory[] {
        const queryEmbedding = EmbeddingService.simpleEmbedding(query);
        
        const scored = this.memories
            .map(m => ({
                memory: m,
                score: EmbeddingService.cosineSimilarity(queryEmbedding, m.embedding || []),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        return scored.map(s => s.memory);
    }

    getByScene(scene: string): VisualMemory[] {
        return this.memories.filter(m => m.scene === scene);
    }

    getRecent(count: number = 10): VisualMemory[] {
        return this.memories
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, count);
    }

    getSceneSummaries(): SceneSummary[] {
        const byScene = new Map<string, VisualMemory[]>();
        
        for (const m of this.memories) {
            if (!byScene.has(m.scene)) {
                byScene.set(m.scene, []);
            }
            byScene.get(m.scene)!.push(m);
        }

        const summaries: SceneSummary[] = [];
        
        for (const [scene, memories] of byScene) {
            if (scene === 'unknown') continue;
            
            summaries.push({
                scene,
                firstSeen: memories[memories.length - 1].timestamp,
                lastSeen: memories[0].timestamp,
                count: memories.length,
                avgConfidence: memories.reduce((a, m) => a + m.confidence, 0) / memories.length,
            });
        }

        return summaries.sort((a, b) => b.count - a.count);
    }

    delete(id: string): boolean {
        const idx = this.memories.findIndex(m => m.id === id);
        if (idx >= 0) {
            this.memories.splice(idx, 1);
            this.save();
            return true;
        }
        return false;
    }

    clear(): void {
        this.memories = [];
        this.save();
    }

    getStats(): {
        totalMemories: number;
        uniqueScenes: number;
        avgConfidence: number;
        oldestMemory: string | null;
        newestMemory: string | null;
    } {
        const scenes = new Set(this.memories.map(m => m.scene));
        
        return {
            totalMemories: this.memories.length,
            uniqueScenes: scenes.size,
            avgConfidence: this.memories.length > 0
                ? this.memories.reduce((a, m) => a + m.confidence, 0) / this.memories.length
                : 0,
            oldestMemory: this.memories.length > 0
                ? this.memories[this.memories.length - 1].timestamp
                : null,
            newestMemory: this.memories.length > 0
                ? this.memories[0].timestamp
                : null,
        };
    }

    formatForPrompt(memories: VisualMemory[]): string {
        if (memories.length === 0) return '';
        
        const lines = ['## 视觉记忆'];
        
        for (const m of memories.slice(0, 3)) {
            const time = new Date(m.timestamp).toLocaleTimeString('zh-CN');
            lines.push(`- [${time}] ${m.description}`);
            if (m.objects.length > 0) {
                lines.push(`  物体: ${m.objects.join(', ')}`);
            }
        }
        
        return lines.join('\n');
    }
}

let instance: VisualMemoryStore | null = null;

export function getVisualMemoryStore(): VisualMemoryStore {
    if (!instance) {
        instance = new VisualMemoryStore();
    }
    return instance;
}
