# Memory Suite 完整优化规格 (Optimization Spec)

> 创建时间: 2025-02-19
> 状态: 执行中

## 执行顺序总览

```
Phase 1 (立即)
├── 模块一：LLM 真流式 SSE — 感知延迟从 3s → <800ms 首 token
└── 模块二：TTS 分段流式 — "边想边说"

Phase 2 (紧跟)
├── 模块三A：Web 前端统一（CSS/导航组件化）
├── 模块三B：LoRA 训练页面 + 后端 API
└── 模块四：Danmaku Bridge SSE 消费

Phase 3 (后续)
├── 模块五：代码质量改善（编码修复、shared/ 清理）
└── SoulOrchestrator 拆分重构
```

---

## 模块一：LLM 真流式 SSE（P0）

### 目标
将端到端感知延迟从 ~3s 降低到 <800ms 首 token

### 当前问题
- `LLMFallbackHandler.generateStream()` 调用 DeepSeek 时使用 `tryDeepseekLLM()`（非流式，等全部生成完才 yield 一次）
- 本地 LLM 的 `generateStream` 虽逐 token yield，但有 `localMaxTimeMs` 硬超时截断
- Manager `/api/chat/stream` 代理已正确 pipe，但上游 MU 并未真正逐 token 推送

### 改动点

#### 1.1 `memory-universe/src/llm/LLMFallbackHandler.ts`
- [x] 新增 `tryDeepseekStream()` 方法：调用 DeepSeek API `stream: true`，解析 SSE 逐 chunk yield
- [x] 修改 `generateStream()`：优先使用 `tryDeepseekStream()` 替代 `tryDeepseekLLM()` + 一次性 yield
- [x] Race 模式：cloud 走真流式，local 走 `localCppService.generateStream()`，谁先出 token 谁赢

#### 1.2 `memory-universe/src/core/SoulOrchestrator.ts`
- [x] `chatStream()` 中 LLM 调用部分已正确使用 `for await`，无需大改
- [ ] 优化超时：fast path memory 500ms→300ms, brainnn 3s→1.5s（待后续微调）

#### 1.3 `manager/server.js`
- [x] `/api/chat/stream` 代理已正确 pipe，添加 `X-Accel-Buffering: no` + `flushHeaders` + timeout

### 验收标准
- 发送消息后 <800ms 内前端收到第一个 SSE token
- 完整回复在 2-3s 内流式完成
- Cloud 不可用时自动降级到 local 流式

---

## 模块二：TTS 分段流式（P0）

### 目标
实现"边想边说"：LLM 输出一句话就立即送 TTS

### 改动点

#### 2.1 `memory-danmaku/bridge.js`
- [x] 改用 SSE 消费 `/api/chat/stream`（MemoryUniverseClient.getReplyStream）
- [x] 实现 `SentenceBuffer`：累积 token，遇标点切分（MessageRouter.streamChatAndSubtitle）
- [x] 每切出一句立即异步送 TTS + Live2D 字幕
- [x] 维护 TTS 队列，由 TTSOrchestrator 的锁机制管理顺序

#### 2.2 `memory-tts/server.js`
- [x] TTS 接口已支持并发请求（现有实现）
- [ ] 添加请求优先级（可选优化）

### 验收标准
- LLM 输出第一句话后 <500ms 内 TTS 开始合成
- 多句话按顺序播放，无重叠
- 异常时降级为等全文再 TTS

---

## 模块三：Web 前端现代化（P1）

### 阶段 A：统一 + 修复

#### 3A.1 提取公共资源
- [x] 创建 `manager/public/css/common.css` — 统一色彩变量和基础样式
- [x] 创建 `manager/public/js/nav.js` — 动态注入导航栏
- [x] 所有 HTML 页面引用公共资源，删除重复 CSS/导航代码

#### 3A.2 统一色彩
- [x] 统一为 index.html 的暗色主题变量

### 阶段 B：LoRA 训练页面

#### 3B.1 前端
- [x] 新建 `manager/public/training.html`
  - 数据概览面板（各数据源样本数）
  - 一键数据准备按钮
  - 训练配置表单（epochs/lr/batch-size/lora-r/lora-alpha）
  - 一键训练按钮 + 实时进度/loss 显示
  - 一键导出部署按钮
  - 训练历史列表

#### 3B.2 后端 API（manager/server.js 新增）
- [x] `POST /api/training/prepare-data` — 执行数据准备
- [x] `GET  /api/training/data-stats` — 获取数据源统计
- [x] `POST /api/training/start` — 启动 LoRA 训练
- [x] `GET  /api/training/status` — 获取训练状态
- [x] `POST /api/training/export` — 导出 GGUF + 部署
- [x] `GET  /api/training/history` — 训练历史
- [x] `POST /api/training/abort` — 中止训练

### 验收标准
- 所有页面视觉风格统一
- 导航栏修改一处全局生效
- LoRA 训练可通过 Web UI 完成全流程

---

## 模块四：Danmaku Bridge SSE 消费（P1）

### 改动点
- [x] `MemoryUniverseClient.getReplyStream()` 实现 SSE 流式消费
- [x] `MessageRouter.streamChatAndSubtitle()` 使用流式 + SentenceBuffer
- [x] 保留 fallback：SSE 失败时降级为 `getReplyFull` 同步返回

---

## 模块五：代码质量改善（P2）

### 5.1 编码修复
- [x] 修复 `SoulOrchestrator.ts` 中 ~60 处乱码（注释/正则/Prompt/命令回复，GBK→UTF-8）
- [x] 修复 JSDoc 注释缺失 `*/` 导致 23 个 TS 编译错误
- [x] TypeScript 编译 0 错误

### 5.2 shared/ 目录清理
- [x] 修复 `PortManager.js` 和 `ServiceRegistry.js` 中的乱码字符

### 5.3 SoulOrchestrator 拆分（长期）
- [ ] 拆分为 ChatPipeline / PromptBuilder / SessionManager / MemoryPipeline / ToolExecutor / InlineModules
