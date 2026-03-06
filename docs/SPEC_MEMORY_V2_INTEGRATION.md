# Memory Suite v2 完整集成与优化规格

## 概述

本文档定义了 Memory Suite v2 的完整集成方案，包括：
- 修复所有已知问题
- 完整集成所有 6 个模块到 SoulOrchestrator
- 统一 Embedding 函数
- 清理冗余配置
- 添加性能测试

---

## 一、问题清单

### 1.1 未集成模块 (4个)

| 模块 | 当前状态 | 目标状态 |
|------|---------|---------|
| VisionService | 仅 API | 自动触发视觉分析 |
| VisualMemoryStore | 仅 API | 检索结果加入 prompt |
| TransparentMemory | 仅 API | 与 Mem0 联动 |
| MemoryR1 | 仅 API | 控制记忆写入决策 |

### 1.2 重复代码 (4处)

| 函数 | 位置 | 问题 |
|------|------|------|
| simpleEmbedding | EvoMemorySystem.ts (128维) | 维度不一致 |
| simpleEmbedding | Mem0StyleMemory.ts (64维) | 维度不一致 |
| simpleEmbedding | VisualMemoryStore.ts (64维) | 维度不一致 |
| cosineSimilarity | 上述 3 个文件 | 代码重复 |

### 1.3 未使用的环境变量 (~15个)

```bash
VISION_SERVICE_PORT
VISION_SERVICE_URL
VISION_USE_MOCK
VISION_AUTO_START
VISION_EVENT_THRESHOLD
VISION_IDLE_FPS
VISION_ACTIVE_FPS
VISION_QUALITY
VISION_YOLO_ENABLED
VISION_YOLO_MODEL
VISION_YOLO_CONFIDENCE
VISION_OCR_ENABLED
VISION_OCR_LANGUAGE
VISION_CAPTION_MODEL
VISION_CLOUD_ENABLED
```

### 1.4 缺失的环境变量定义 (6个)

```bash
EVO_MEMORY_PATH
EVO_STRATEGY_PATH
MEM0_FACTS_PATH
MEMORY_R1_POLICY_PATH
MEMORY_R1_HISTORY_PATH
TRANSPARENT_MEMORIES_PATH
```

---

## 二、集成方案

### 2.1 VisionService 集成

**触发条件**: 用户消息包含视觉关键词

```typescript
// SoulOrchestrator.ts
const visionKeywords = ['看', '看到', '画面', '屏幕', '显示', '是什么', '这个', '那个'];

if (visionKeywords.some(kw => input.content.includes(kw))) {
    const vision = getVisionService();
    const buffer = await vision.captureScreen();
    const result = await vision.analyzeImage(buffer);
    memorySection += '\n\n' + vision.formatForPrompt(result);
    
    // 存储视觉记忆
    const visualStore = getVisualMemoryStore();
    await visualStore.store(result);
}
```

### 2.2 VisualMemoryStore 集成

**集成位置**: `prepareLlmRequest` 方法

```typescript
// 检索相关视觉记忆
const visualMemories = getVisualMemoryStore().search(input.content, 3);
if (visualMemories.length > 0) {
    memorySection += '\n\n' + getVisualMemoryStore().formatForPrompt(visualMemories);
}
```

### 2.3 TransparentMemory 集成

**联动机制**: Mem0 事实变更时自动同步

```typescript
// Mem0StyleMemory.ts - add 方法中
async add(input: string, output: string, userId: string): Promise<Fact[]> {
    // ... 提取事实 ...
    
    // 同步到 TransparentMemory
    const transparent = getTransparentMemory();
    await transparent.syncFromMem0(userId, facts);
    
    return facts;
}
```

### 2.4 MemoryR1 集成

**决策点**: 记忆写入前

```typescript
// SoulOrchestrator.ts - persistMemory 方法中
const r1 = getMemoryR1();
const decision = r1.decide({
    content: input.content,
    context: '对话记忆',
    importance: r1.estimateImportance(input.content),
    recency: 1.0,
    redundancy: r1.estimateRedundancy(input.content, existingMemories),
});

if (decision.action === 'store') {
    await this.canonicalMemory.addFact(...);
    this.evoMemory.addExperience(...);
    await this.mem0.add(...);
} else if (decision.action === 'compress') {
    // 压缩后存储
    const compressed = await this.compressMemory(input.content);
    await this.canonicalMemory.addFact(compressed);
}
```

---

## 三、代码重构

### 3.1 统一 Embedding 函数

**目标**: 所有模块使用 `EmbeddingService`

```typescript
// EmbeddingService.ts - 新增静态方法
export class EmbeddingService {
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
        
        const norm = Math.sqrt(embedding.reduce((a, b) => a + b * b, 0)) || 1;
        return embedding.map(v => v / norm);
    }
    
    static cosineSimilarity(a: number[], b: number[]): number {
        if (!a || !b || a.length !== b.length) return 0;
        let dotProduct = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
    }
}
```

**修改文件**:
- EvoMemorySystem.ts → 使用 `EmbeddingService.simpleEmbedding`
- Mem0StyleMemory.ts → 使用 `EmbeddingService.simpleEmbedding`
- VisualMemoryStore.ts → 使用 `EmbeddingService.simpleEmbedding`

### 3.2 移除重复代码

每个文件中移除本地的 `simpleEmbedding` 和 `cosineSimilarity` 函数，改为：

```typescript
import { EmbeddingService } from './EmbeddingService';

// 使用
const embedding = EmbeddingService.simpleEmbedding(text);
const similarity = EmbeddingService.cosineSimilarity(a, b);
```

---

## 四、环境变量优化

### 4.1 完整的 .env 配置（带中文注释）

```bash
# ============================================================
# Memory Suite v2 运行时配置
# ============================================================

# ------------------------------------------------------------
# [核心端口和URL]
# ------------------------------------------------------------
MANAGER_PORT=8080                    # 管理器端口
MEMORY_UNIVERSE_PORT=4005            # 记忆宇宙服务端口
BRAINNN_PORT=4007                    # 神经网络服务端口
AGENT_CORE_PORT=4009                 # Agent核心端口
MEMORY_SYSTEM_V2_PORT=4010           # 记忆系统v2端口
REFLECTION_ENGINE_PORT=4011          # 反思引擎端口
NEURO_SYMBOLIC_BRIDGE_PORT=4012      # 神经符号桥接端口
PREDICTION_ENGINE_PORT=4013          # 预测引擎端口
LIVE2D_PORT=4002                     # Live2D服务端口
DANMAKU_SERVICE_PORT=4003            # 弹幕服务端口

# ------------------------------------------------------------
# [用户和身份]
# ------------------------------------------------------------
PERSONA_NAME=月影                    # AI人格名称
CREATOR_USER_ID=Jieice               # 创建者用户ID
CREATOR_DISPLAY_NAME=宇杰            # 创建者显示名称
CREATOR_USER_ALIASES=宇杰_Prime      # 创建者别名
MU_CREATOR_TOKEN=mu_secure_shield_v5_2026  # 创建者令牌

# ------------------------------------------------------------
# [本地LLM配置]
# ------------------------------------------------------------
USE_LOCAL_LLM=true                   # 是否使用本地LLM
LOCAL_LLM_ENGINE=cpp                 # LLM引擎: cpp | openai | deepseek
LOCAL_LLM_MODEL_PATH=D:\AI\memory-suite\models\Qwen3-4B-Instruct\Qwen3-4B-Instruct-2507-Q4_K_M.gguf
LOCAL_LLM_CONTEXT_SIZE=640           # 上下文窗口大小
LOCAL_LLM_GPU_LAYERS=auto            # GPU层数: auto | 数字
LOCAL_LLM_TEMPERATURE=0.7            # 生成温度 (0.0-1.0)
LOCAL_LLM_TOP_P=0.9                  # Top-p采样
LOCAL_LLM_MAX_TOKENS=192             # 最大生成token数
LOCAL_LLM_TIMEOUT_MS=60000           # 超时时间(毫秒)

# ------------------------------------------------------------
# [视觉服务配置 - Qwen3-VL-4B]
# ------------------------------------------------------------
VISION_ENABLED=true                   # 是否启用视觉服务
VISION_MODEL_PATH=D:\AI\memory-suite\models\Qwen3VL-4B-Instruct-Q4_K_M\Qwen3VL-4B-Instruct-Q4_K_M.gguf
VISION_MMPROJ_PATH=D:\AI\memory-suite\models\Qwen3VL-4B-Instruct-Q4_K_M\mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf
VISION_USE_GPU=true                   # 是否使用GPU加速
VISION_GPU_LAYERS=auto               # GPU层数
VISION_CONTEXT_SIZE=2048             # 视觉模型上下文大小
VISION_CAPTURE_INTERVAL=5000         # 自动截屏间隔(毫秒)
VISION_MAX_IMAGE_SIZE=1280           # 最大图像尺寸(像素)
VISION_CACHE_DIR=data/vision_cache   # 视觉缓存目录

# ------------------------------------------------------------
# [Evo-Memory 经验复用系统]
# ------------------------------------------------------------
EVO_MEMORY_PATH=data/evo_memory/experiences.jsonl    # 经验存储路径
EVO_STRATEGY_PATH=data/evo_memory/strategies.json    # 策略存储路径
EVO_MAX_EXPERIENCES=1000             # 最大经验数量

# ------------------------------------------------------------
# [Mem0 事实提取系统]
# ------------------------------------------------------------
MEM0_FACTS_PATH=data/mem0_facts/facts.jsonl         # 事实存储路径
MEM0_MAX_FACTS_PER_USER=100          # 每用户最大事实数

# ------------------------------------------------------------
# [Transparent Memory 透明文件记忆]
# ------------------------------------------------------------
TRANSPARENT_MEMORIES_PATH=data/memories             # Markdown记忆目录

# ------------------------------------------------------------
# [MemoryR1 强化学习记忆管理]
# ------------------------------------------------------------
MEMORY_R1_POLICY_PATH=data/memory_r1/policy.json    # 策略权重路径
MEMORY_R1_HISTORY_PATH=data/memory_r1/history.jsonl # 学习历史路径
MEMORY_R1_LEARNING_RATE=0.01         # 学习率

# ------------------------------------------------------------
# [TTS语音合成]
# ------------------------------------------------------------
TTS_ENGINE=sovits                    # TTS引擎: sovits | edge | none
TTS_SERVICE_PORT=4014                # TTS服务端口
SOVITS_API_URL=http://127.0.0.1:9880 # SoVITS API地址
SOVITS_REF_AUDIO=D:\AI\memory-suite\memory-tts\reference\ref.wav  # 参考音频
SOVITS_SPEED=1.08                    # 语速

# ------------------------------------------------------------
# [云端LLM备用]
# ------------------------------------------------------------
SLOW_PATH_CLOUD_ENABLED=true         # 是否启用云端慢路径
DEEPSEEK_API_KEY=sk-xxx              # DeepSeek API密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat         # 使用的模型

# ------------------------------------------------------------
# [记忆和一致性]
# ------------------------------------------------------------
MEMORY_BUDGET_CHARS_FAST=180         # 快路径记忆预算(字符)
MEMORY_BUDGET_CHARS_SLOW=720         # 慢路径记忆预算(字符)
MEMORY_CANON_MAX_FACTS=16            # 规范记忆最大事实数
SELF_CRITIC_ENABLED=true             # 是否启用自批评

# ------------------------------------------------------------
# [路由和延迟调优]
# ------------------------------------------------------------
FAST_PATH_ENABLED=true               # 是否启用快路径
FAST_PATH_MAX_CHARS=24               # 快路径最大字符数
ROUTE_COMPLEXITY_THRESHOLD=0.38      # 路由复杂度阈值
SLO_FAST_P95_MS=1200                 # 快路径P95延迟目标(ms)
SLO_SLOW_P95_MS=12000                # 慢路径P95延迟目标(ms)

# ------------------------------------------------------------
# [调试和日志]
# ------------------------------------------------------------
DEBUG=false                          # 调试模式
LOG_LEVEL=info                       # 日志级别: debug | info | warn | error
AUTO_RESTART=false                   # 自动重启
```

---

## 五、性能测试方案

### 5.1 延迟测试脚本

创建 `scripts/test-latency.mjs`:

```javascript
/**
 * Memory Suite 延迟测试
 * 测试各模块的响应时间
 */

import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.MEMORY_UNIVERSE_URL || 'http://localhost:4005';
const ITERATIONS = 10;

const tests = [
    { name: 'Evo-Memory Stats', endpoint: '/api/evo-memory/stats', method: 'GET' },
    { name: 'Evo-Memory Retrieve', endpoint: '/api/evo-memory/strategies', method: 'GET' },
    { name: 'Mem0 Stats', endpoint: '/api/mem0/stats', method: 'GET' },
    { name: 'Mem0 Search', endpoint: '/api/mem0/search?query=test', method: 'GET' },
    { name: 'Vision Status', endpoint: '/api/vision/status', method: 'GET' },
    { name: 'Vision Capture', endpoint: '/api/vision/capture', method: 'POST' },
    { name: 'Visual Memory Stats', endpoint: '/api/visual-memory/stats', method: 'GET' },
    { name: 'Transparent Memory Stats', endpoint: '/api/transparent-memory/stats', method: 'GET' },
    { name: 'MemoryR1 Stats', endpoint: '/api/memory-r1/stats', method: 'GET' },
    { name: 'MemoryR1 Decide', endpoint: '/api/memory-r1/decide', method: 'POST', body: { content: '测试内容' } },
    { name: 'Memory Stats (Core)', endpoint: '/api/memory/stats', method: 'GET' },
    { name: 'Chat (Fast)', endpoint: '/api/chat', method: 'POST', body: { content: '你好', route: 'fast' } },
    { name: 'Chat (Slow)', endpoint: '/api/chat', method: 'POST', body: { content: '请详细介绍一下你的记忆系统', route: 'slow' } },
];

async function measureLatency(name, endpoint, method, body) {
    const times = [];
    
    for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now();
        
        try {
            const response = await fetch(`${BASE_URL}${endpoint}`, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined,
            });
            
            const end = performance.now();
            times.push(end - start);
        } catch (err) {
            times.push(-1);
        }
    }
    
    const validTimes = times.filter(t => t >= 0);
    if (validTimes.length === 0) {
        return { name, status: 'FAILED', avg: -1, min: -1, max: -1, p95: -1 };
    }
    
    validTimes.sort((a, b) => a - b);
    const avg = validTimes.reduce((a, b) => a + b, 0) / validTimes.length;
    const min = validTimes[0];
    const max = validTimes[validTimes.length - 1];
    const p95 = validTimes[Math.floor(validTimes.length * 0.95)];
    
    return { name, status: 'OK', avg, min, max, p95 };
}

async function main() {
    console.log('=== Memory Suite 延迟测试 ===\n');
    console.log(`目标: ${BASE_URL}`);
    console.log(`迭代次数: ${ITERATIONS}\n`);
    
    const results = [];
    
    for (const test of tests) {
        process.stdout.write(`测试 ${test.name}... `);
        const result = await measureLatency(test.name, test.endpoint, test.method, test.body);
        results.push(result);
        console.log(result.status === 'OK' ? `${result.avg.toFixed(0)}ms` : 'FAILED');
    }
    
    console.log('\n=== 结果汇总 ===\n');
    console.log('| 模块 | 平均(ms) | 最小(ms) | 最大(ms) | P95(ms) | 状态 |');
    console.log('|------|----------|----------|----------|---------|------|');
    
    for (const r of results) {
        if (r.status === 'OK') {
            const warning = r.avg > 1000 ? '⚠️' : (r.avg > 500 ? '⚡' : '✅');
            console.log(`| ${r.name} | ${r.avg.toFixed(0)} | ${r.min.toFixed(0)} | ${r.max.toFixed(0)} | ${r.p95.toFixed(0)} | ${warning} |`);
        } else {
            console.log(`| ${r.name} | - | - | - | - | ❌ |`);
        }
    }
    
    // 高延迟警告
    const slowModules = results.filter(r => r.avg > 500);
    if (slowModules.length > 0) {
        console.log('\n⚠️ 高延迟模块 (>500ms):');
        for (const m of slowModules) {
            console.log(`  - ${m.name}: ${m.avg.toFixed(0)}ms`);
        }
    }
    
    // 保存结果
    const reportPath = 'data/latency-report.json';
    fs.writeFileSync(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        baseUrl: BASE_URL,
        iterations: ITERATIONS,
        results,
    }, null, 2));
    console.log(`\n报告已保存: ${reportPath}`);
}

main();
```

### 5.2 性能基准

| 模块 | 目标延迟 | 警告阈值 |
|------|---------|---------|
| Memory Stats | < 50ms | > 100ms |
| Mem0 Search | < 100ms | > 200ms |
| Vision Capture | < 2000ms | > 5000ms |
| MemoryR1 Decide | < 50ms | > 100ms |
| Chat (Fast) | < 500ms | > 1000ms |
| Chat (Slow) | < 5000ms | > 10000ms |

---

## 六、实施步骤

### Phase 1: 代码重构 (优先级: 高)

1. [ ] 统一 EmbeddingService
2. [ ] 移除重复的 simpleEmbedding/cosineSimilarity
3. [ ] 更新所有模块使用 EmbeddingService

### Phase 2: 模块集成 (优先级: 高)

1. [ ] VisionService → SoulOrchestrator
2. [ ] VisualMemoryStore → prompt 构建
3. [ ] TransparentMemory → Mem0 联动
4. [ ] MemoryR1 → 记忆写入决策

### Phase 3: 配置优化 (优先级: 中)

1. [ ] 清理未使用的环境变量
2. [ ] 添加缺失的环境变量
3. [ ] 添加中文注释

### Phase 4: 测试验证 (优先级: 中)

1. [ ] 创建延迟测试脚本
2. [ ] 运行测试并生成报告
3. [ ] 优化高延迟模块

---

## 七、验收标准

1. **功能完整性**: 所有 6 个模块在对话中自动工作
2. **代码质量**: 无重复代码，统一使用 EmbeddingService
3. **配置清晰**: .env 有完整中文注释
4. **性能达标**: 所有模块延迟在目标范围内
5. **测试通过**: `node scripts/test-memory-v2.mjs` 全部通过
