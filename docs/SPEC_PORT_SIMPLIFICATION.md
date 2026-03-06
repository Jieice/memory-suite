# 端口简化内联规格

## 目标

将 AGENT_CORE (4009) 和 NEURO_SYMBOLIC (4012) 内联到 memory-universe，减少端口数量和网络调用。

---

## 一、AGENT_CORE (4009) 内联

### 当前功能

```python
# brainnn/agent_core.py 主要功能
class AgentCore:
    - ThinkingState: 思考状态管理
    - ProactiveState: 主动发言状态
    - analyze_situation(): 分析当前情境
    - should_proactive_speak(): 判断是否应该主动发言
```

### 内联方案

在 SoulOrchestrator.ts 中添加：

```typescript
// 简化的 AgentCore 内联实现
interface ThinkingState {
    isThinking: boolean;
    topic: string | null;
    startedAt: number | null;
    turnCount: number;
}

interface ProactiveState {
    lastProactiveAt: number;
    proactiveCooldown: number;
    boredomLevel: number;
    socialNeedLevel: number;
}

class InlineAgentCore {
    private thinkingState: ThinkingState;
    private proactiveState: ProactiveState;
    
    analyzeSituation(context: {
        userId: string;
        recentTopics: string[];
        lastInteraction: number;
    }): { shouldThink: boolean; shouldProactive: boolean };
    
    shouldProactiveSpeak(soulState: SoulState): boolean;
}
```

### 调用位置

- `SoulOrchestrator.ts:5382` - `axios.post(\`${this.agentCoreEndpoint}/think\`, ...)`

---

## 二、NEURO_SYMBOLIC (4012) 内联

### 当前功能

```python
# brainnn/neuro_symbolic_bridge.py 主要功能
class NeuroSymbolicBridge:
    - RuleEngine: 规则引擎
    - check_sensitive_words(): 敏感词检查
    - check_repetition(): 重复检测
    - detect_greeting(): 问候检测
    - apply_rules(): 应用规则
```

### 内联方案

在 SoulOrchestrator.ts 中添加：

```typescript
// 简化的规则引擎内联实现
class InlineRuleEngine {
    private sensitivePatterns: RegExp[];
    private greetingPatterns: RegExp[];
    
    checkContent(text: string): {
        isSensitive: boolean;
        isGreeting: boolean;
        isRepetition: boolean;
        warnings: string[];
    };
    
    private detectRepetition(text: string, history: string[]): boolean;
    private detectGreeting(text: string): boolean;
}
```

### 调用位置

- `SoulOrchestrator.ts:5352` - `axios.post(\`${this.neuroSymbolicEndpoint}/check\`, ...)`

---

## 三、实施步骤

### Phase 1: 内联 AgentCore

1. [ ] 在 SoulOrchestrator.ts 中添加 InlineAgentCore 类
2. [ ] 实现 analyzeSituation 方法
3. [ ] 实现 shouldProactiveSpeak 方法
4. [ ] 替换外部调用为内联调用
5. [ ] 移除 agentCoreEndpoint 属性

### Phase 2: 内联 NeuroSymbolic

1. [ ] 在 SoulOrchestrator.ts 中添加 InlineRuleEngine 类
2. [ ] 实现 checkContent 方法
3. [ ] 实现敏感词/问候/重复检测
4. [ ] 替换外部调用为内联调用
5. [ ] 移除 neuroSymbolicEndpoint 属性

### Phase 3: 清理

1. [ ] 更新 .env 移除端口配置
2. [ ] 更新 .env.example
3. [ ] 验证编译
4. [ ] 测试运行

---

## 四、简化后的端口

| 端口 | 服务 | 状态 |
|------|------|------|
| 8080 | MANAGER | 保留 |
| 4002 | LIVE2D | 保留 |
| 4003 | DANMAKU | 保留 |
| 4005 | MEMORY_UNIVERSE | 核心 |
| 4007 | BRAINNN | 保留 |
| 4014 | TTS | 保留 |
| 9880 | SOVITS | 保留 |

**总计: 7 个端口** (从原来的 10 个减少 3 个)

---

## 五、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 功能差异 | 中 | 保持简化版本，核心功能不变 |
| 性能影响 | 低 | 内联后无网络开销，更快 |
| 维护复杂度 | 低 | 代码集中在一个文件 |
