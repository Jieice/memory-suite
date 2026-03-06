# SoulOrchestrator Mixin 模式拆分计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 6837 行的 SoulOrchestrator.ts 按功能域拆分为 ~10 个 Mixin 文件，每个 500-800 行，保持运行时行为完全不变。

**Architecture:** TypeScript Mixin 模式。每个 Mixin 是一个函数，接收 Base 类并返回扩展类。SoulOrchestrator 通过链式 Mixin 组合所有功能。共享状态通过 `OrchestratorBase` 抽象类暴露 protected 属性。

**Tech Stack:** TypeScript, RxJS, EventEmitter

---

## 文件结构

```
src/core/
├── SoulOrchestrator.ts          # 瘦壳：组合所有 Mixin，导出最终类 (~200行)
├── OrchestratorBase.ts           # 基类：所有属性、构造函数、类型导出 (~400行)
├── OrchestratorTypes.ts          # 所有 type/interface 定义 (~250行)
├── mixins/
│   ├── SessionMixin.ts           # Session 生命周期管理 (~300行)
│   ├── MemoryMixin.ts            # 记忆读写、持久化、预算 (~800行)
│   ├── PromptMixin.ts            # System prompt 构建、上下文组装 (~600行)
│   ├── RoutingMixin.ts           # LLM 路由、采样、Cloud 决策 (~500行)
│   ├── ToolMixin.ts              # Tool shadow、执行、Manager 调用 (~300行)
│   ├── QualityMixin.ts           # 质量检测、重写、一致性守卫 (~600行)
│   ├── DialogueMixin.ts          # 对话策略、话题追踪、偏好提取 (~500行)
│   ├── CommandMixin.ts           # Creator 命令、Trait 控制、Eval (~400行)
│   ├── MetricsMixin.ts           # 延迟统计、路由统计、日志 (~250行)
│   └── CognitiveMixin.ts         # 认知流、reactToStimulus、chat/chatStream (~800行)
├── InlineAgentCore.ts            # 提取的 InlineAgentCore 类 (~160行)
├── InlineRuleEngine.ts           # 提取的 InlineRuleEngine 类 (~60行)
```

## Mixin 拆分明细

### Mixin 1: OrchestratorTypes.ts (~250行)
提取所有 type 和 interface 定义 (L223-451)：
- CognitiveEvent, ResponseRoute, SessionPhase, ViewerTier
- SessionState, SessionUpdate, ContextBudgetResult
- ToolShadowDecision, ToolExecutionResult, ToolCallTrace
- ComplexityAnalysis, LatencyBucket, DialogueStrategy
- AnimeTraitProfile, AnimeTraitRuntime, ActiveTraitControl
- CotPayload, CotThinking, CotTraceRecord
- CreatorEvalChatCase, CreatorEvalChatCaseResult
- 等等

### Mixin 2: OrchestratorBase.ts (~400行)
- 所有 private 属性改为 protected
- 构造函数（L770-827）
- 静态方法 readBoundedFloat, normalizeAnimeTraitProfile, normalizeCloudRuntimeMode
- 基础工具方法：ensureRequestId, isNeuralPolicyMode, isMeaningfulText, shouldReplyInChinese, clamp01, escapeRegExp, estimateTokenCount, getLocalizedErrorPhrase, buildFallbackReply, buildRescueReply

### Mixin 3: SessionMixin.ts (~300行)
- getOrCreateSession, getSessionKey
- pushSessionMessage
- generateSessionSummary, maybeUpdateSessionSummary
- maybeConsolidateToLongTerm
- completeLatestGoalIfNeeded
- buildSessionSection

### Mixin 4: MemoryMixin.ts (~800行)
- persistMemory (L6131-6565, 435行 — 最大方法之一)
- buildContextBudget (L3982-4152, 171行)
- normalizeMemoryKey, tokenizeForMemoryMatch, lexicalOverlapScore, formatMemoryTime
- extractPreferenceUpdates, extractTaskUpdates
- detectFactConflict, findPreferenceConflict, findTaskConflict
- shouldReplaceConflict, pushPreferenceFact
- normalizePreferenceTopic, sentimentsAreOpposite
- 记忆写入门控相关方法

### Mixin 5: PromptMixin.ts (~600行)
- buildSystemPrompt (L3367-3483, 117行)
- buildNeuralStyleGuidance (L3283-3366, 84行)
- buildCreatorChannelSection
- buildPersonaGuard
- buildStreamContext
- buildPromptWithHardLimit
- buildFallbackStyleGuidance, buildFallbackTraitSignal
- resolveActiveTraitControl

### Mixin 6: RoutingMixin.ts (~500行)
- decideInitialRoute, inferRouteReason, refineRouteWithRuleSignals
- buildSamplingPlan
- shouldPreferCloud, hasCloudKey
- getLlmRequestTimeoutMs, getServiceTimeout
- isLiveForegroundTurn, shouldUseRealtimeGuard
- decideModuleParticipationLevel
- prepareLlmRequest (L6169-6428, 260行)
- extractLLMText

### Mixin 7: ToolMixin.ts (~300行)
- detectToolShadow, buildToolShadowContext
- mapDecisionToolToToolId, isUsefulToolContent
- buildToolArgs, extractToolResultContent
- callToolViaManager, routeToolViaManager
- executeToolsIfNeeded
- buildToolExecutionContext
- extractExpression, extractTimezone

### Mixin 8: QualityMixin.ts (~600行)
- enforceConsistencyGuard (L4171-4400, 230行)
- detectQualityIssue, tryRewriteLowQuality
- tryRegenerateForQualityIssue, tryRegenerateForStateGrounding
- tryDirectAnswerRepair, isPredictionAlternativeAcceptable
- polishResponse (L6429-6565, 137行)
- stripTemplateNoise, stripExcessiveEmoji, stripReasoning
- normalizeChineseTechnicalTerms
- hasLanguageMismatch, hasExcessiveEnglishLeakage
- personaConsistencyScore, candidateScore, responseSimilarity, computeNoveltyScore
- runSelfCritic

### Mixin 9: DialogueMixin.ts (~500行)
- buildDialogueStrategy, renderStrategyAsPrompt
- applyHonestUncertainty
- updateTopicTracking, extractTopicKeywords, suggestTopicShift
- inferViewerTier
- shouldInjectGoalNudge, buildGoalNudge, applyGoalDriver
- isKnowledgeSensitiveQuery, isCapabilityScopeQuery
- buildCapabilityScopeFallbackReply, enforceCapabilityScopeAnswer
- detectStateGroundingIssue, fetchRuntimeStateEvidence
- formatRuntimeStateSummary, extractRuntimeStateTargets, getRuntimeServiceAliasMap
- 身份/名称管理：getAddressableName, sanitizeUnsafePublicIdsInReply, isSafePublicAddressName 等

### Mixin 10: CommandMixin.ts (~400行)
- tryHandleCreatorLlmCommand, tryHandleCreatorTraitCommand
- tryHandleCreatorEvalCommand, runCreatorEvalChat
- buildCreatorEvalChatCases, scoreCreatorEvalChatCase
- formatCreatorEvalChatStatus, formatCreatorEvalChatReport
- hasEvalFallbackReply, percentileMs
- buildImmediateCommandResponse
- isAnimeTraitProfile, formatAnimeTraitRuntime, buildAnimeTraitRuntimePayload
- formatCloudRoutingRuntime, recordLlmProvider

### Mixin 11: MetricsMixin.ts (~250行)
- logConsistencyStats, recordRoute, recordViewerTier, recordContextBudget
- observeLatency, recordTurnLatency, recordStageLatency, summarizeLatency
- withSoftTimeout, runDetached

### Mixin 12: CognitiveMixin.ts (~800行)
- perceive, initializeCognitiveStream, processCognitiveEvent
- reactToStimulus (L5416-6130, 715行 — 核心方法)
- chat, chatStream
- buildDefaultSignal
- syncWorldStateToBrain, startWorldSync
- getDominantEmotion, generateVoiceParams
- getLegacyState, triggerDreaming, dispose
- analyzeInputComplexity, containsComplexIntent
- isMemoryGroundingQuery
- parseCotPayload, ensureTraceDirExists, appendCotTrace, appendBadCotSample, applyNoThinkDirective

---

## 执行顺序

### Phase A: 提取类型和基类（低风险）
1. 创建 `OrchestratorTypes.ts` — 提取所有 type/interface
2. 创建 `InlineAgentCore.ts` — 提取 InlineAgentCore 类
3. 创建 `InlineRuleEngine.ts` — 提取 InlineRuleEngine 类
4. 创建 `OrchestratorBase.ts` — 提取属性和构造函数
5. 验证：TypeScript 编译通过

### Phase B: 逐个提取 Mixin（每个 Mixin 一个 commit）
6. MetricsMixin — 最简单，无外部依赖
7. ToolMixin — 相对独立
8. CommandMixin — 依赖 Trait 状态
9. SessionMixin — 依赖 SessionState
10. DialogueMixin — 依赖 Session + Memory
11. PromptMixin — 依赖多个模块
12. QualityMixin — 依赖 Prompt + Session
13. RoutingMixin — 依赖 Config
14. MemoryMixin — 大块，依赖 Session
15. CognitiveMixin — 最后提取，依赖所有其他 Mixin

### Phase C: 组装和验证
16. 更新 SoulOrchestrator.ts 为瘦壳
17. 全量 TypeScript 编译验证
18. 运行现有测试
19. 手动启动测试

---

## Mixin 模式示例

```typescript
// mixins/MetricsMixin.ts
import { OrchestratorBase } from '../OrchestratorBase';
import { ResponseRoute, LatencyBucket, ContextBudgetResult } from '../OrchestratorTypes';

type Constructor<T = {}> = new (...args: any[]) => T;

export function MetricsMixin<TBase extends Constructor<OrchestratorBase>>(Base: TBase) {
  return class extends Base {
    protected recordRoute(route: ResponseRoute, reason: string): void { ... }
    protected observeLatency(bucket: LatencyBucket, rawMs: number): void { ... }
    // ...
  };
}
```

```typescript
// SoulOrchestrator.ts (瘦壳)
import { OrchestratorBase } from './OrchestratorBase';
import { MetricsMixin } from './mixins/MetricsMixin';
import { SessionMixin } from './mixins/SessionMixin';
// ...

const Mixed = CognitiveMixin(
  QualityMixin(
    RoutingMixin(
      MemoryMixin(
        PromptMixin(
          DialogueMixin(
            CommandMixin(
              ToolMixin(
                SessionMixin(
                  MetricsMixin(OrchestratorBase)
                )
              )
            )
          )
        )
      )
    )
  )
);

export class SoulOrchestrator extends Mixed {
  // 仅保留需要 override 或不属于任何 Mixin 的方法
}
```

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| `this` 引用在 Mixin 中无法访问其他 Mixin 的方法 | OrchestratorBase 声明所有方法签名为 abstract 或 stub |
| 循环依赖 | Mixin 之间不直接 import，通过 Base 类型访问 |
| reactToStimulus 715行太大 | 先整体迁移，后续再拆分为子步骤 |
| 编译错误 | 每个 Mixin 提取后立即编译验证 |
