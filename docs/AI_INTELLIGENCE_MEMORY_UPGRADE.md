# AI 智能与记忆系统升级指南

本文档基于近期测试与行业调研，整理**如何提升 Memory Suite 的 AI 智能程度和记忆系统**，并给出可落地的升级方向与步骤。

---

## 一、测试情况（本次改动）

- **shared 单元测试**：5 个 suite、80 个用例全部通过（含 CircuitBreakerClient、FallbackManager、FallbackLogger、ErrorCategories）。
- **memory-universe**：`npx tsc --noEmit` 通过；requestId 已在 Manager 生成并随 header/body 传入 Universe，日志中带 `rid=`。
- **Redis 队列**：未配置 `REDIS_URL` 时保持同步直连；配置 `REDIS_URL` + `MANAGER_CHAT_USE_QUEUE=true` 后，POST /api/chat 入队并返回 202，后台消费者转发到 Universe。
- **GPT-SoVITS**：memory-tts README 已补充 V2/V4/V2Pro 版本建议与 .env 说明。

---

## 二、如何提升「智能程度」

### 2.1 模型与上下文

| 方向 | 说明 | 在本项目中的对应 |
|------|------|------------------|
| **更强/更大 LLM** | 快路用轻量模型、慢路用大模型（你已有快慢路） | 慢路可接 Claude/GPT-4/DeepSeek 等，快路保持本地低延迟 |
| **更长上下文** | 128k+ 窗口成本高，多用摘要与检索 | 控制 SoulOrchestrator 的 context 预算，优先检索注入而非塞满历史 |
| **系统提示与人设** | 明确人设、禁忌、风格 | 已有 persona、cannot 等，可继续细化并做 A/B 测试 |

### 2.2 推理与规划

| 方向 | 说明 | 落地建议 |
|------|------|----------|
| **Chain-of-Thought（CoT）** | 让模型先「一步步想」再答 | 在慢路或复杂问题时，system 里要求「先简短推理再给最终回复」，并只把最终回复送 TTS |
| **ReAct（思考–行动–观察）** | 推理与调用工具交替 | 已有 ToolShadow/ToolExec，可强化：工具结果反馈后要求「根据结果再决定下一步」 |
| **反思与自我批评** | 生成后再用模型检查并改写 | 已有 SelfCritic/ConsistencyGuard，可加大慢路中的反思权重或增加一轮「检查–改写」 |
| **多步规划** | 复杂问题拆成子目标 | 在 Agent Core 或 SoulOrchestrator 中，对高复杂度请求先产出 2–3 步计划再执行（可仅慢路） |

### 2.3 工具与知识

- **工具调用**：已有 tools 与 ToolExec，可扩展更多工具（查知识库、查时间、调用 API），并保证工具结果稳定进入上下文。
- **RAG**：长期知识用「向量检索 + 摘要」注入当前轮，避免整段历史塞进上下文；下面「记忆系统」会细说。

---

## 三、如何升级「记忆系统」

### 3.1 行业常见分层

| 层级 | 作用 | 本项目现状 |
|------|------|------------|
| **工作记忆** | 当前轮上下文、最近几轮原文 | SoulOrchestrator 的 session 与 context 预算 |
| **短期/会话记忆** | 本轮会话内的摘要或要点 | 有 MemoryRetriever、session；可加强「会话内摘要」 |
| **长期记忆** | 跨会话、持久化、可检索 | VectorStore、CanonicalMemoryStore、BrainNN memory_system_v2 |

### 3.2 六类记忆操作（可对标落地）

| 操作 | 含义 | 在本项目中的落地建议 |
|------|------|------------------------|
| **巩固（Consolidation）** | 把短期经验变成持久记忆 | 在 Reflection Engine 或 Universe 侧：会话结束/定时把「本轮要点」写入 VectorStore 或 memory_system_v2 |
| **索引（Indexing）** | 便于检索的结构与向量 | 已有 EmbeddingService + VectorStore；可对写入内容做 chunk、多键索引（按用户/时间/类型） |
| **更新（Updating）** | 用新信息修正旧记忆 | 检索到相关记忆后，允许「更新」而非仅追加；memory_system_v2 若支持 update 可对接 |
| **遗忘（Forgetting）** | 抑制过时或敏感内容 | 按时间或重要性降权、归档或软删除；可先在 MemoryRetriever 检索时按时间衰减 |
| **检索（Retrieval）** | 按当前输入召回相关记忆 | 已有 memoryRetriever.retrieve；可加「混合检索」：向量 + 关键词 + 时间范围 |
| **压缩（Compression）** | 摘要减量、保留要点 | 写入长期记忆前用 LLM 做摘要；大段对话先压缩再存 |

### 3.3 可参考的框架与范式

| 框架/范式 | 核心思路 | 与本项目的结合方式 |
|-----------|----------|----------------------|
| **MemoRAG** | 长上下文 LLM 建全局记忆 + 强模型生成最终答 | 用现有 VectorStore/检索结果作「全局记忆」输入，强模型只做最终生成 |
| **Mem0 / Mem0g** | 提取–更新循环；图结构实体关系 | 在 Reflection 或独立 job 中：从对话提取事实 → 检索相似记忆 → ADD/UPDATE/DELETE，保持一致性 |
| **MemGPT** | 内存分页、working context 动态更新 | 对应「context 预算」+ 按需注入检索结果；可显式区分「当前工作集」与「外存」 |
| **A-MEM（Zettelkasten）** | 笔记式记忆、双向链接、动态索引 | 长期记忆存成「卡片」+ 关联；MemoryEncoder 可产出带 link 的结构化记忆 |

### 3.4 本项目现有记忆相关位置

- **memory-universe**  
  - `memory/`: VectorStore, MemoryEncoder, MemoryRetriever, CanonicalMemoryStore, DreamingService  
  - SoulOrchestrator 中：`memoryRetriever.retrieve`、`memory_retrieve` 阶段、`memory_system_store`（持久化）
- **brainnn**  
  - `memory_system_v2.py`：统一记忆接口、与 Universe 对接  
  - `reflection_engine.py`：反思与学习反馈  
  - `agent_core.py`：思考与规划  

升级时优先在这些位置加「巩固、检索、压缩、更新」，再考虑引入 Mem0 式循环或 MemGPT 式分页。

---

## 四、推荐升级步骤（按优先级）

### 阶段 A：低成本、高收益

1. **记忆检索可观测**  
   在 `MemoryRetriever.retrieve` 和 BrainNN memory 调用处打点：检索条数、耗时、命中率；可选暴露到 `/metrics` 或现有 Prometheus，便于调参。
2. **会话内摘要**  
   每 N 轮或会话结束时，用 LLM 对近期对话做简短摘要，写入当前 session 或短期存储；下一轮检索时优先带「上轮摘要」，减少噪声。
3. **检索策略增强**  
   在现有向量检索基础上加：关键词/稀疏检索、时间衰减（最近记忆权重大）、按用户/类型过滤，形成简单混合检索。

### 阶段 B：记忆质量与一致性

4. **巩固与压缩**  
   在 Reflection Engine 或 Universe 侧增加「巩固」步骤：把本轮重要信息用 LLM 压缩成几条记忆条目，再写入 VectorStore / memory_system_v2。
5. **更新与去重**  
   写入长期记忆前，先检索相似记忆；若高度相似则更新而非重复插入，避免冗余与冲突。
6. **可选 Mem0 式循环**  
   单独服务或定时任务：从最新对话中提取事实 → 检索已有记忆 → 执行 ADD/UPDATE/DELETE，保持记忆一致（可先做小规模试点）。

### 阶段 C：智能与推理

7. **慢路 CoT/ReAct**  
   在慢路 system prompt 中明确「先简要推理/规划再给最终回复」；工具调用后增加「根据工具结果再决策」的一轮，强化 ReAct 行为。
8. **反思与改写**  
   对慢路回复做一次 SelfCritic/一致性检查，不通过则用 LLM 改写后再送 TTS，提升稳定性与合规性。
9. **更大/更强模型**  
   慢路接入更强 API 模型（Claude、GPT-4、DeepSeek 等），快路保持当前低延迟模型，形成清晰分工。

---

## 五、参考资料（可进一步搜索）

- **MemoRAG**：长期记忆 + RAG 新范式  
- **Mem0 / Mem0g**：可扩展代理记忆、图结构记忆  
- **MemGPT**：无限上下文与内存分页  
- **A-MEM**：Zettelkasten 式代理记忆（2025）  
- **ReAct**：Synergizing Reasoning and Acting in Language Models  
- **「AI Agents 记忆系统：3 大类、6 种操作」**（火山引擎等复盘文章）

---

## 六、实施记录（阶段 A 已完成）

以下为按「阶段 A → B → C」顺序落地后的记录，便于后续维护与扩展。

### 阶段 A1：记忆检索可观测（已完成）

- **MemoryRetriever**：`retrieve()` 内打点（lastCount、lastMs、lastAt、totalRetrievals、totalRetrievalMs）；支持 `RetrievalOptions.requestId`，当 `rid !== 'na'` 时打日志 `[MemoryRetriever] rid=... count=... ms=...`。
- **getRetrievalStats()**：由 `memory/index.ts` 导出，供 SoulOrchestrator 合并到 `/api/memory/stats`。
- **SoulOrchestrator**：两处 `memoryRetriever.retrieve(...)` 传入 `requestId: input.requestId`；`getMemoryStats()` 返回 `{ ...vectorStore.getStats(), retrieval: getRetrievalStats() }`。
- **效果**：`GET /api/memory/stats` 响应中包含 `retrieval`（最近一次检索条数、耗时及累计统计），便于调参与监控。

### 阶段 A2：会话内摘要（已完成）

- **SessionState**：新增 `sessionSummary?: string`、`lastSummaryTurn?: number`。
- **配置**：会话摘要**默认开启**（`SESSION_SUMMARY_ENABLED !== 'false'`）；`SESSION_SUMMARY_EVERY_N_TURNS` 默认 6，表示每 N 轮触发一次摘要。设为 `false` 可关闭。
- **流程**：主聊天流程在 `pushSessionMessage(..., 'assistant')` 后调用 `maybeUpdateSessionSummary(session, input.requestId)`；当 `turnCount % N === 0` 时异步调用 LLM 对近期 `lastUserMessages` + `lastReplies` 生成 1～2 句摘要，写入 `session.sessionSummary` 并更新 `lastSummaryTurn`。
- **注入**：`buildSessionSection()` 中若存在 `session.sessionSummary`，则追加 `session_summary=...`，下一轮构造上下文时会带上「上轮/会话摘要」。

### 阶段 A3：检索策略增强（已完成）

- **时间衰减**：`RetrievalOptions.timeWeight`（默认 0.2）在 `rerankForDialogue` 中用于放大近期记忆权重；`recencyBoost` 系数为 `0.08 + timeWeight * 0.35`（上限 0.5），近期记忆得分更高。
- **按类型过滤**：`RetrievalOptions.memoryTypes?: MemoryType[]`；若长度为 1 则在 `VectorStore.search` 时传 `type`；若长度 > 1 则在 rerank 前按 `memoryTypes` 过滤，只保留指定类型的记忆。
- **混合检索**：已有向量相似度 + `lexicalOverlap`（关键词重叠）+ 同用户/创作者/类型加权；A3 在此基础上强化了时间权重与类型过滤，形成简单混合策略。

### 阶段 B：记忆质量与一致性（已完成）

- **B1 巩固与压缩**  
  - 配置：`CONSOLIDATION_ENABLED !== 'false'` 开启；`CONSOLIDATION_EVERY_N_TURNS` 默认 6（与会话摘要同频）。  
  - 流程：在会话摘要更新后异步执行 `maybeConsolidateToLongTerm`：用 LLM 从「摘要 + 近期对话」中抽取 1～3 条关键事实（每句一句），经 `memoryEncoder.encodeSemanticMemory` 编码后通过 `addOrUpdateMemory` 写入 VectorStore（走 B2 更新/去重逻辑）。  
  - 效果：会话级信息被压缩为语义记忆，减少冗余、利于长期检索。

- **B2 更新与去重**  
  - 配置：`MEMORY_UPDATE_ENABLED !== 'false'` 开启；`MEMORY_UPDATE_SIMILARITY_THRESHOLD` 默认 0.90（同用户、相似度 ≥ 阈值则更新原条目不新增）。  
  - 流程：每次写入 VectorStore 前（含单轮编码与巩固写入）调用 `addOrUpdateMemory(record, userId)`：用 `record.embedding` + `userId` 检索；若存在相似度 ≥ 阈值的记录则 `vectorStore.update(id, ...)`，否则 `vectorStore.add(record)`。  
  - 效果：同一主题/用户下避免重复插入，保持长期记忆紧凑一致。

- **B3 Mem0 式循环（可选）**  
  - 配置：`MEM0_STYLE_CONSOLIDATION_ENABLED=true` 时，在**夜间反思**（DreamingService.dream）中启用。  
  - 流程：在每日核心记忆与日报之后，对近期 24h 情景记忆按用户分组；对每用户最近 5 条用 LLM 抽取 1～2 条事实，经 `encodeSemanticMemory` 后 `vectorStore.add`（夜间批处理不做相似更新，依赖检索时的时间衰减与 B2 在聊天路径的去重）。  
  - 效果：定时「提取 → 写入语义记忆」，与 B1 形成会话内 + 批处理双通道巩固。

### 阶段 C：智能与推理（已完成）

- **C1 慢路 CoT/ReAct**  
  - **CoT**：慢路 system prompt 增加规则：「复杂问题可先在 \`<think>...</think>\` 内简要推理，仅 \`<think>\` 外内容作为回复」；下游已用 `stripReasoning` 去除 think 块再送 TTS。  
  - **ReAct**：慢路规则增加「若 Context 含 tool execution results，请基于该结果作答（观察后再回复）」；工具结果已在 `userContent` 的 Context 中注入，模型据此回复即形成「行动–观察–回复」闭环。  
- **C2 反思与改写**  
  - 已有 SelfCritic（runSelfCritic）与不通过时的 LLM 改写；**默认开启**：`SELF_CRITIC_REWRITE_ENABLED !== 'false'`（不设即开启，设 `false` 可关闭）。  
- **C3 慢路更强模型**  
  - 慢路优先走云 API（DeepSeek 等）：**默认开启** `SLOW_PATH_CLOUD_ENABLED !== 'false'`、`SLOW_PATH_CLOUD_ALWAYS !== 'false'`；需配置 `DEEPSEEK_API_KEY` 与可选 `DEEPSEEK_SLOW_MODEL`。快路仍为低延迟本地/轻量模型。

### 默认开启汇总

- **会话与记忆**：会话摘要、巩固（B1）、更新与去重（B2）、Mem0 式夜间巩固（B3）均为默认开启（对应 env 用 `!== 'false'` 或 `=== 'true'` 判定）。  
- **阶段 C**：SelfCritic 改写、慢路云模型与 CoT/ReAct 规则默认开启；关闭时需显式设对应 env 为 `false`。

---

## 七、小结

- **智能**：阶段 C 已落地（慢路 CoT/ReAct、反思改写默认开启、慢路更强模型默认倾向）；可在现有基础上继续做多步规划或更强 API 接入。
- **记忆**：阶段 A + B 已完成；会话摘要、巩固、更新与去重、Mem0 式循环均默认开启。
- **落地**：A/B/C 三阶段均已实施；相关功能默认开启，需关闭时通过环境变量显式关闭。

完成上述步骤后，AI 的「像人一样记住、推理、用工具」能力会明显增强，且与当前架构兼容。
