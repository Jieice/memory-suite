# Memory Suite 升级 Spec v2.0

基于 2024-2025 最新 AI Agent 研究，将 Memory Suite 从 60-70% Neuro-sama 成功力提升至 85%+。

---

## 0. 项目概述

### 0.1 目标

将 Memory Suite 升级为具有真正学习能力的 AI VTuber 系统：
- 经验复用能力（而非仅仅是反思）
- 自动事实提取与记忆管理
- 视觉理解能力
- 透明可编辑的记忆系统
- 强化学习驱动的记忆优化

### 0.2 硬件约束

目标机器: **R5 5500 + RTX 2070 Super 8GB + RAM 16GB**
- 推理: 4B GGUF Q4_K_M 可行
- 视觉模型: Moondream 2B (CPU) 或 Qwen2-VL-2B (GPU)
- 训练: 仅 QLoRA/LoRA，低序列长度，离线调度

### 0.3 非目标

- 不实现完整的游戏 AI（仅视觉理解）
- 不使用云端大模型进行视觉处理（延迟考虑）
- 不进行实时训练（仅离线）

---

## 1. Phase 1: Evo-Memory 集成

### 1.1 目标

将 Evo-Memory 系统集成到 SoulOrchestrator，实现真正的经验复用。

### 1.2 核心概念

**Reflection ≠ Learning**

| 概念 | 定义 | 时间尺度 |
|------|------|----------|
| Reflection | 修正当前任务的推理错误 | 短期（单次会话） |
| Experience Reuse | 从过去任务抽象通用经验 | 长期（跨会话） |

### 1.3 实现清单

#### 1.3.1 修改 SoulOrchestrator.ts

```typescript
// 新增导入
import { getEvoMemory, Experience } from '../memory/EvoMemorySystem';

// 在 chat() 方法中添加
async chat(input: string, userId?: string): Promise<ChatResponse> {
    // 1. 检索相关成功经验
    const relevantExperiences = this.evoMemory.retrieveRelevantExperience(input, 5);
    
    // 2. 将经验注入 system prompt
    const experienceContext = this.evoMemory.formatForPrompt(relevantExperiences);
    
    // 3. 生成回复
    const response = await this.generateResponse(input, experienceContext);
    
    // 4. 记录经验（延迟反馈）
    this.evoMemory.addExperience(input, response.text, 'neutral', { userId });
    
    return response;
}
```

#### 1.3.2 添加反馈机制

```typescript
// 新增 API 端点: POST /api/feedback
async function handleFeedback(req, res) {
    const { experienceId, feedback } = req.body;
    // feedback: 'success' | 'failure'
    await evoMemory.updateFeedback(experienceId, feedback);
}
```

#### 1.3.3 定时 Refine Memory

```typescript
// 在 DreamingService 中添加
async runDailyRefine(): Promise<void> {
    const result = await this.evoMemory.refineMemory();
    this.logger.log(`Refine 完成: ${JSON.stringify(result)}`);
}
```

### 1.4 验收标准

- [ ] 经验能够正确存储和检索
- [ ] Refine Memory 能够删除噪声、合并相似、抽象策略
- [ ] 成功经验能够在相似输入时被复用
- [ ] 重复错误率降低 20%+

---

## 2. Phase 2: Mem0 记忆层集成

### 2.1 目标

集成 Mem0 式事实提取系统，实现轻量级记忆层。

### 2.2 核心概念

**存储事实而非原始对话**

| 传统记忆 | Mem0 记忆 |
|----------|-----------|
| 存储完整对话 | 提取关键事实 |
| 冗余信息多 | 精简高效 |
| Token 成本高 | Token 成本降低 80-90% |

### 2.3 实现清单

#### 2.3.1 修改 SoulOrchestrator.ts

```typescript
import { getMem0, Fact } from '../memory/Mem0StyleMemory';

async chat(input: string, userId?: string): Promise<ChatResponse> {
    // 1. 搜索相关事实
    const relevantFacts = this.mem0.search(input, userId, 10);
    
    // 2. 格式化为 prompt
    const memoryContext = this.mem0.formatForPrompt(relevantFacts);
    
    // 3. 生成回复
    const response = await this.generateResponse(input, memoryContext);
    
    // 4. 自动提取事实
    await this.mem0.add(input, response.text, userId);
    
    return response;
}
```

#### 2.3.2 添加记忆管理 API

```typescript
// GET /api/memory/facts - 获取所有事实
// DELETE /api/memory/facts/:id - 删除事实
// PUT /api/memory/facts/:id - 更新事实
```

#### 2.3.3 用户画像生成

```typescript
async generateUserProfile(userId: string): Promise<UserProfile> {
    const facts = this.mem0.getAll(userId);
    
    return {
        preferences: facts.filter(f => f.category === 'preference'),
        events: facts.filter(f => f.category === 'event'),
        relationships: facts.filter(f => f.category === 'relationship'),
        traits: facts.filter(f => f.category === 'trait'),
    };
}
```

### 2.4 验收标准

- [ ] 事实能够正确提取和分类
- [ ] 相似事实能够合并而非重复存储
- [ ] 记忆检索延迟 < 100ms
- [ ] 记忆质量提升 20%+

---

## 3. Phase 3: 视觉记忆系统

### 3.1 目标

添加视觉理解能力，支持直播画面理解。

### 3.2 技术选型

| 方案 | 模型 | 延迟 | 硬件需求 |
|------|------|------|----------|
| 方案 A | Moondream 2B | ~500ms | CPU 可行 |
| 方案 B | Qwen2-VL-2B | ~300ms | GPU 4GB |
| 方案 C | 云端 API | ~1s | 无 |

**推荐**: 方案 B（Qwen2-VL-2B，GGUF 格式）

### 3.3 实现清单

#### 3.3.1 创建 VisionService.ts

```typescript
interface VisionResult {
    description: string;
    objects: string[];
    scene: string;
    confidence: number;
}

class VisionService {
    private model: LlamaModel | null = null;
    
    async initialize(): Promise<void> {
        this.model = await loadModel('models/qwen2-vl-2b-q4_k_m.gguf');
    }
    
    async analyzeImage(imageBuffer: Buffer): Promise<VisionResult> {
        const result = await this.model.complete({
            images: [imageBuffer],
            prompt: '描述这张图片的内容。',
        });
        return this.parseResult(result);
    }
    
    async captureScreen(): Promise<Buffer> {
        // 使用 screenshot-desktop 或类似库
    }
}
```

#### 3.3.2 创建 VisualMemory.ts

```typescript
interface VisualMemory {
    id: string;
    timestamp: string;
    imageHash: string;
    description: string;
    objects: string[];
    scene: string;
    embedding: number[];
}

class VisualMemoryStore {
    async store(imageBuffer: Buffer, description: string): Promise<VisualMemory> {
        const hash = this.hashImage(imageBuffer);
        const embedding = await this.embed(description);
        
        const memory: VisualMemory = {
            id: generateId(),
            timestamp: new Date().toISOString(),
            imageHash: hash,
            description,
            embedding,
        };
        
        await this.save(memory);
        return memory;
    }
    
    async search(query: string): Promise<VisualMemory[]> {
        const queryEmbedding = await this.embed(query);
        return this.vectorSearch(queryEmbedding);
    }
}
```

#### 3.3.3 集成到 SoulOrchestrator

```typescript
async chat(input: string, userId?: string): Promise<ChatResponse> {
    // 检测是否需要视觉上下文
    if (this.needsVisionContext(input)) {
        const screenshot = await this.vision.captureScreen();
        const visionResult = await this.vision.analyzeImage(screenshot);
        
        // 将视觉上下文注入 prompt
        const visionContext = `当前画面: ${visionResult.description}`;
        // ...
    }
}
```

### 3.4 验收标准

- [ ] 能够捕获直播画面
- [ ] 能够生成画面描述
- [ ] 视觉记忆能够存储和检索
- [ ] 视觉上下文能够改善对话质量

---

## 4. Phase 4: 透明文件记忆系统

### 4.1 目标

实现 Claude Memory 式透明文件记忆系统。

### 4.2 核心概念

**完全可见、可编辑的记忆**

```
data/memories/
├── global/
│   ├── PERSONALITY.md    # 人格设定
│   └── KNOWLEDGE.md      # 通用知识
├── users/
│   ├── user_123/
│   │   ├── PROFILE.md    # 用户画像
│   │   ├── PREFERENCES.md # 偏好
│   │   └── EVENTS.md     # 重要事件
│   └── user_456/
│       └── ...
└── sessions/
    └── 2026-02-12.md     # 会话总结
```

### 4.3 实现清单

#### 4.3.1 创建 TransparentMemory.ts

```typescript
class TransparentMemory {
    private basePath: string;
    
    async writeGlobalMemory(type: string, content: string): Promise<void> {
        const path = `${this.basePath}/global/${type}.md`;
        await fs.writeFile(path, content);
    }
    
    async writeUserMemory(userId: string, type: string, content: string): Promise<void> {
        const dir = `${this.basePath}/users/${userId}`;
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(`${dir}/${type}.md`, content);
    }
    
    async loadAllMemory(userId?: string): Promise<string> {
        const memories: string[] = [];
        
        // 加载全局记忆
        memories.push(await this.loadGlobalMemory());
        
        // 加载用户记忆
        if (userId) {
            memories.push(await this.loadUserMemory(userId));
        }
        
        return memories.join('\n\n');
    }
    
    async generateUserProfile(userId: string, facts: Fact[]): Promise<string> {
        const lines = [
            `# 用户画像: ${userId}`,
            ``,
            `## 偏好`,
            ...facts.filter(f => f.category === 'preference').map(f => `- ${f.content}`),
            ``,
            `## 重要事件`,
            ...facts.filter(f => f.category === 'event').map(f => `- ${f.content}`),
        ];
        
        return lines.join('\n');
    }
}
```

#### 4.3.2 添加记忆编辑 API

```typescript
// GET /api/memory/files - 列出所有记忆文件
// GET /api/memory/files/:path - 获取记忆文件内容
// PUT /api/memory/files/:path - 更新记忆文件
// POST /api/memory/sync - 同步 Mem0 事实到文件
```

#### 4.3.3 自动同步机制

```typescript
async syncMem0ToFiles(): Promise<void> {
    const allFacts = this.mem0.getAll();
    const byUser = groupBy(allFacts, 'userId');
    
    for (const [userId, facts] of Object.entries(byUser)) {
        const profile = await this.transparentMemory.generateUserProfile(userId, facts);
        await this.transparentMemory.writeUserMemory(userId, 'PROFILE', profile);
    }
}
```

### 4.4 验收标准

- [ ] 记忆文件能够正确生成
- [ ] 用户可以通过 API 编辑记忆
- [ ] 编辑后的记忆能够影响对话
- [ ] 支持版本控制（Git）

---

## 5. Phase 5: Memory-R1 强化学习

### 5.1 目标

使用强化学习优化记忆管理策略。

### 5.2 核心概念

**让 AI 学会"记住什么"**

```
状态: 当前记忆候选 + 上下文
动作: store | compress | forget
奖励: 用户反馈 + 对话质量
```

### 5.3 实现清单

#### 5.3.1 创建 MemoryR1.ts

```typescript
interface MemoryState {
    content: string;
    context: string;
    importance: number;
    recency: number;
    redundancy: number;
}

type MemoryAction = 'store' | 'compress' | 'forget';

interface MemoryPolicy {
    predict(state: MemoryState): MemoryAction;
    update(state: MemoryState, action: MemoryAction, reward: number): void;
}

class MemoryR1 {
    private policy: MemoryPolicy;
    
    decide(state: MemoryState): MemoryAction {
        return this.policy.predict(state);
    }
    
    learn(state: MemoryState, action: MemoryAction, reward: number): void {
        this.policy.update(state, action, reward);
    }
    
    calculateReward(feedback: UserFeedback): number {
        let reward = 0;
        
        if (feedback.positive) reward += 1;
        if (feedback.negative) reward -= 1;
        if (feedback.repeated) reward -= 0.5;  // 重复错误
        
        return reward;
    }
}
```

#### 5.3.2 简化版策略网络

```typescript
class SimpleMemoryPolicy implements MemoryPolicy {
    private weights: number[] = [0.3, 0.3, 0.2, 0.2]; // importance, recency, redundancy, random
    
    predict(state: MemoryState): MemoryAction {
        const score = 
            this.weights[0] * state.importance +
            this.weights[1] * state.recency -
            this.weights[2] * state.redundancy +
            this.weights[3] * Math.random();
        
        if (score > 0.7) return 'store';
        if (score > 0.3) return 'compress';
        return 'forget';
    }
    
    update(state: MemoryState, action: MemoryAction, reward: number): void {
        // 简化的策略梯度更新
        const learningRate = 0.01;
        if (action === 'store' && reward > 0) {
            this.weights[0] += learningRate * state.importance;
        }
        // ... 更多更新规则
    }
}
```

#### 5.3.3 集成到记忆流程

```typescript
async addMemoryCandidate(content: string, context: string): Promise<void> {
    const state: MemoryState = {
        content,
        context,
        importance: await this.estimateImportance(content),
        recency: 1.0,
        redundancy: await this.estimateRedundancy(content),
    };
    
    const action = this.memoryR1.decide(state);
    
    switch (action) {
        case 'store':
            await this.mem0.add(content, '', context.userId);
            break;
        case 'compress':
            const compressed = await this.compress(content);
            await this.mem0.add(compressed, '', context.userId);
            break;
        case 'forget':
            // 不存储
            break;
    }
}
```

### 5.4 验收标准

- [ ] 策略网络能够做出合理决策
- [ ] 奖励信号能够正确计算
- [ ] 长期学习后记忆质量提升
- [ ] 存储效率提升 20%+

---

## 6. 集成测试

### 6.1 端到端测试

```typescript
describe('Memory Suite v2 Integration', () => {
    it('should store and retrieve experiences', async () => {
        const evo = getEvoMemory();
        evo.addExperience('你好', '你好呀！', 'success');
        
        const retrieved = evo.retrieveRelevantExperience('嗨');
        expect(retrieved.length).toBeGreaterThan(0);
    });
    
    it('should extract and store facts', async () => {
        const mem0 = getMem0();
        await mem0.add('我喜欢原神', '原神是个不错的游戏！', 'user1');
        
        const facts = mem0.search('游戏偏好', 'user1');
        expect(facts.some(f => f.content.includes('原神'))).toBe(true);
    });
    
    it('should integrate vision context', async () => {
        const vision = new VisionService();
        const result = await vision.analyzeImage(testImage);
        expect(result.description).toBeDefined();
    });
});
```

### 6.2 性能基准

| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| 记忆检索延迟 | ~200ms | <100ms |
| 事实提取延迟 | N/A | <500ms |
| 视觉分析延迟 | N/A | <500ms |
| 总对话延迟 | ~1-2s | <1s |

---

## 7. 文件清单

### 7.1 新增文件

```
memory-universe/src/memory/
├── EvoMemorySystem.ts      # Phase 1
├── Mem0StyleMemory.ts      # Phase 2
├── VisionService.ts        # Phase 3
├── VisualMemoryStore.ts    # Phase 3
├── TransparentMemory.ts    # Phase 4
└── MemoryR1.ts             # Phase 5

data/
├── evo_memory/
│   ├── experiences.jsonl
│   └── strategies.json
├── mem0_facts/
│   └── facts.jsonl
├── visual_memory/
│   └── images/
└── memories/
    ├── global/
    └── users/
```

### 7.2 修改文件

```
memory-universe/src/core/SoulOrchestrator.ts  # 集成所有记忆系统
memory-universe/src/memory/DreamingService.ts # 添加 Refine 定时任务
memory-universe/src/index.ts                  # 新增 API 端点
```

---

## 8. 时间估算

| Phase | 工作量 | 依赖 |
|-------|--------|------|
| Phase 1 | 2天 | 无 |
| Phase 2 | 2天 | Phase 1 |
| Phase 3 | 4天 | Phase 2 |
| Phase 4 | 1天 | Phase 2 |
| Phase 5 | 5天 | Phase 1-4 |
| **总计** | **14天** | - |

---

## 9. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 视觉模型延迟过高 | 中 | 高 | 使用更小模型或降级到 CPU |
| 记忆检索影响对话延迟 | 中 | 中 | 异步预加载 + 缓存 |
| 强化学习不收敛 | 低 | 低 | 使用简化策略 + 人工规则兜底 |
| 存储空间不足 | 低 | 中 | 定期清理 + 压缩策略 |
