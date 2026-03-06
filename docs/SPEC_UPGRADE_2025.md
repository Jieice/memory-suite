# Memory Suite 升级实施规格（SPEC）2025

本文档是 [UPGRADE_OPTIMIZATION_2025.md](./UPGRADE_OPTIMIZATION_2025.md) 的可执行落地规格：阶段划分、任务清单、验收标准，以及**可从互联网获取的 Skills / Agents / 参考资料**，便于直接动手。

---

## 第一部分：可用的外部 Skills / Agents / 资源

以下资源可直接使用或复制到项目中，减少从零造轮子。

### 1. Cursor 规则与技能（提升 AI 协作效率）

| 资源 | 用途 | 如何获取/使用 |
|------|------|----------------|
| **Awesome Cursor Rules** | 现成的 `.cursorrules` 模板（Node/TS/React 等） | GitHub: [PatrickJS/awesome-cursorrules](https://github.com/PatrickJS/awesome-cursorrules)，在 `rules/` 下找 `typescript-nodejs-*` 或 `react-typescript-nextjs-nodejs-*`，复制到项目 `.cursor/rules/` 或整理为 `.mdc` |
| **Cursor create-rule skill** | 在项目里规范创建 Cursor 规则 | 你本机已有：`C:\Users\Jieic\.cursor\skills-cursor\create-rule\SKILL.md`，在 Cursor 里说「用 create-rule 给 Memory Suite 加一条 TypeScript 后端规则」即可按流程生成 |
| **Cursor create-skill skill** | 为项目或个人创建专用 Skill（如「跑链路测试」「改 TTS 配置」） | 本机：`C:\Users\Jieic\.cursor\skills-cursor\create-skill\SKILL.md`，可说「用 create-skill 给 Memory Suite 建一个启动与自测的 skill」 |
| **cursor-automator** | 让 Cursor 更自主的规则集合 | GitHub: [ShalevAri/cursor-automator](https://github.com/ShalevAri/cursor-automator)，按 README 用 setup 脚本安装 |

**建议第一步**：用 **create-rule** 为 Memory Suite 生成一条「项目级规则」（例如：TypeScript 风格、API 约定、日志与错误处理），这样后续改代码时 AI 会自带项目上下文。

### 2. 熔断器（Circuit Breaker）

| 资源 | 用途 | 使用方式 |
|------|------|----------|
| **opossum** | Node 熔断器，防 LLM/TTS 连续失败拖垮服务 | npm: `npm i opossum`，文档 [nodeshift.dev/opossum](https://nodeshift.dev/opossum/)。**注意**：v9 要求 Node ≥20；若坚持 Node 18 用 `opossum@8` |
| **opossum-prometheus** | 熔断器指标接入 Prometheus | npm: `opossum-prometheus`，与现有 Grafana 监控对接 |
| **Red Hat 博客示例** | 快速理解 opossum 用法 | [Fail fast with Opossum circuit breaker in Node.js](https://developers.redhat.com/blog/2021/04/15/fail-fast-with-opossum-circuit-breaker-in-node-js) |

集成位置建议：**shared**（或 manager）中封装「调用 LLM / TTS 的 HTTP 客户端」，用 opossum 包装请求函数，并设 fallback 返回降级文案。

### 3. 流式 LLM（SSE）

| 资源 | 用途 | 使用方式 |
|------|------|----------|
| **SSE 标准** | `Content-Type: text/event-stream`，`data:` 行 + 双换行 | MDN / 任意 SSE 教程 |
| **Node + Express 流式** | 在 Express 里写 SSE 端点，把 LLM 流推到前端 | 参考 [Building Real-Time Text Streaming with SSE in Node.js](https://dev.to/axrisi/building-real-time-text-streaming-with-sse-in-nodejs-4d5f)、[Streaming LLM responses in Next.js](https://upstash.com/blog/sse-streaming-llm-responses)（逻辑可移植到 Express） |
| **前端 EventSource** | 浏览器端消费 SSE | `new EventSource(url)`，监听 `message`，解析 `data` |

当前链路：Manager `POST /api/chat` → axios 转发 → Memory Universe `orchestrator.chat()` → 一次性返回。流式改造点：Memory Universe 的 LLM 调用改为流式读取 → 用 SSE 写 res；Manager 对 `/api/chat/stream` 做**流式代理**（pipe 或逐 chunk 转发），不缓冲整响应。

### 4. Docker 与编排

| 资源 | 用途 | 使用方式 |
|------|------|----------|
| **Node 官方镜像** | 多阶段构建 Node + TypeScript | `node:20-alpine`，先 `npm ci && npm run build`，再只拷贝 `dist` + `node_modules` 运行 |
| **docker-compose** | 一键起 Manager / Universe / TTS / BrainNN / Live2D / Danmaku | 每个服务一个 `service`，`depends_on` + `healthcheck`，端口与 `.env` 对齐现有 `start-manager.bat` |

无需额外「agent」：用现有 Cursor 让 AI 按「Node + Express + 多服务」生成 `Dockerfile` 和 `docker-compose.yml` 即可。

### 5. 记忆 / RAG 与可观测

| 资源 | 用途 | 使用方式 |
|------|------|----------|
| **MemR3 / Zep 等** | 记忆检索与反思闭环思路 | 论文/博客参考架构，不必直接引入；可在 Memory System V2 封装层加「检索 + 简单指标」 |
| **OpenTelemetry / 请求 ID** | 全链路 trace | 在 Manager 生成 `requestId`，放进 header 或 body，Universe / BrainNN / TTS 日志都带该 ID，便于 grep 排查 |

---

## 第二部分：实施阶段与任务清单

### Phase 0：准备（1 天内）

| 序号 | 任务 | 验收标准 | 参考 |
|------|------|----------|------|
| 0.1 | 统一 Node 版本为 18+（推荐 20） | 根与各子项目 `package.json` 的 `engines.node` 为 `>=18.0.0` 或 `>=20.0.0`；memory-tts 从 14 改为 18+ | UPGRADE_OPTIMIZATION_2025 §2.2 |
| 0.2 | 根目录执行 `npm audit` | 无 critical；high 有缓解或升级方案 | - |
| 0.3 | 为项目添加 Cursor 规则 | 在 `.cursor/rules/` 下有一条「Memory Suite 后端/TS 约定」的 `.mdc` 规则 | 第一部分 §1 create-rule |
| 0.4 | （可选）从 awesome-cursorrules 复制一份 Node/TS 规则 | 可根据需要裁剪为项目专用 | Awesome Cursor Rules |

### Phase 1：熔断与健壮性（约 3–5 天）

| 序号 | 任务 | 验收标准 | 参考 |
|------|------|----------|------|
| 1.1 | 在 shared 或 manager 中引入 opossum | 安装 `opossum`（Node 20 用最新，Node 18 用 8.x），类型 `@types/opossum` | 第一部分 §2 |
| 1.2 | 封装「调用 LLM」的熔断器 | 超时与现有 LLM 超时一致（如 15s），errorThresholdPercentage 50，resetTimeout 30s，fallback 返回降级文案 | README 降级消息 |
| 1.3 | 封装「调用 TTS」的熔断器 | 同上，超时 10s，fallback 可返回静默或降级提示 | - |
| 1.4 | 将 Manager/Universe 中实际调用 LLM/TTS 的路径改为经熔断器 | 行为与现有一致，仅增加熔断与 fallback；现有 FallbackManager 可与其配合 | shared/FallbackManager |
| 1.5 | （可选）opossum-prometheus | Prometheus 可采集熔断器 open/fallback 等指标，Grafana 展示 | 第一部分 §2 |

### Phase 2：Chat 流式（约 5–7 天）

| 序号 | 任务 | 验收标准 | 参考 |
|------|------|----------|------|
| 2.1 | Memory Universe：LLM 层支持流式 | 若使用 OpenAI/DeepSeek 等，调用其 stream 选项，得到 async iterator 或 stream | 第一部分 §3 |
| 2.2 | Memory Universe：新增 `POST /api/chat/stream` | 响应 `Content-Type: text/event-stream`，按 SSE 格式推送 token 或 JSON 行（如 `{ "token": "x" }`） | SSE 标准 |
| 2.3 | SoulOrchestrator.chat 增加「流式模式」 | 在保留现有 `chat()` 一次性返回的前提下，新增 `chatStream()` 或参数，内部走 LLM stream → 写入 SSE | memory-universe SoulOrchestrator |
| 2.4 | Manager：新增 `/api/chat/stream` 代理 | 将请求转发到 Universe 的 `/api/chat/stream`，并**流式转发**响应（不缓冲整 body） | manager server.js 现有 /api/chat 代理 |
| 2.5 | 前端/弹幕桥接（可选） | 若需要页面或 OBS 内「边出字边播」，用 EventSource 或 fetch + ReadableStream 消费 `/api/chat/stream` | 第一部分 §3 前端 EventSource |

### Phase 3：可观测与运维（约 2–4 天）

| 序号 | 任务 | 验收标准 | 参考 |
|------|------|----------|------|
| 3.1 | 全链路 requestId | Manager 收到请求时生成 `requestId`（或从 header 取），传给 Universe（header/body），Universe 传给下游；各服务日志打印 requestId | - |
| 3.2 | 记忆检索简单指标 | Memory System V2 调用处打点：检索条数、耗时；可选暴露到 `/metrics` 或现有 Prometheus | UPGRADE_OPTIMIZATION_2025 §3.1 |
| 3.3 | 各服务健康检查 | Manager 对依赖服务调 `/health`（或现有探活），在 UI 或 `/api/health-check` 中展示 | README 已有 health-check |

### Phase 4：容器化（约 2–3 天）

| 序号 | 任务 | 验收标准 | 参考 |
|------|------|----------|------|
| 4.1 | 为 manager / memory-universe / memory-tts / memory-danmaku 编写 Dockerfile | 能独立 `docker build` 并运行，端口与 .env 一致 | 第一部分 §4 |
| 4.2 | 根目录 docker-compose.yml | 编排上述服务 + BrainNN（Python 镜像）+ Live2D（若可行），`depends_on` + healthcheck，与 start-manager.bat 行为对齐 | - |
| 4.3 | README 更新 | 增加「Docker 启动」小节，保留 bat 方式 | - |

### Phase 5：TTS / Live2D 优化（按需）

| 序号 | 任务 | 验收标准 | 参考 |
|------|------|----------|------|
| 5.1 | GPT-SoVITS 版本评估 | 文档注明当前使用版本，并评估升级 V2/V4/V2Pro 的收益与兼容性 | UPGRADE_OPTIMIZATION_2025 §4 |
| 5.2 | Live2D 性能检查 | 按 Cubism 文档检查网格/参数数量、WebGL 用法，必要时做绘制顺序优化 | UPGRADE_OPTIMIZATION_2025 §5 |

---

## 第三部分：执行顺序与依赖

```
Phase 0（准备） 
    → Phase 1（熔断）  可并行
    → Phase 2（流式）  ← 依赖 0
    → Phase 3（可观测）可穿插在 1/2 之后
    → Phase 4（Docker） 依赖 0，可与 1/2/3 并行
    → Phase 5（TTS/Live2D） 按需
```

建议**先做 Phase 0 + Phase 1**，再开 Phase 2（流式）和 Phase 3（requestId + 指标）；Phase 4 可与 2/3 并行。

---

## 第四部分：验收与回归

- **每次 Phase 结束**：跑现有烟雾测试 `npm run smoke`（或 `scripts/test-full-chain.bat`），确保无回退。
- **流式上线后**：保留原 `POST /api/chat` 非流式接口，兼容现有调用方；新客户端再切 `/api/chat/stream`。
- **Docker**：用 docker-compose 启动后，用 Postman/curl 打 `/api/chat` 与健康检查，与 bat 启动结果一致。

---

## 第五部分：本 SPEC 与 UPGRADE 文档的关系

- **UPGRADE_OPTIMIZATION_2025.md**：为什么做、做哪些方向、优先级。
- **本文 SPEC_UPGRADE_2025.md**：怎么做、分几阶段、每步做什么、用什么技能/库/资料。

两篇一起用：先看 UPGRADE 定方向，再按 SPEC 拆任务执行；执行时优先用「第一部分」里列出的现成 skills 与资源，减少重复劳动。

---

## 第六部分：实施记录

### Phase 0（已完成）
- **0.1** 根、manager、memory-universe、memory-tts、memory-danmaku 的 `package.json` 已统一 `"engines": { "node": ">=18.0.0" }`。
- **0.2** 根目录已执行 `npm audit`，无 critical；high 为 axios 等，可后续 `npm audit fix`。
- **0.3** 项目 Cursor 规则已存在：`.cursor/rules/memory-suite-backend.mdc`。

### Phase 1（已完成）
- **1.1–1.4** 已在 **shared** 引入 `opossum@^8.2.0`（根、manager、memory-universe 均已安装），并新增：
  - `shared/CircuitBreakerClient.ts`：单例 LLM/TTS 熔断器，超时与 `FallbackManager.TIMEOUT_CONFIG` 一致，fallback 返回统一降级文案。
  - `shared/CircuitBreakerClient.test.ts`：4 个用例，成功/失败路径覆盖。
- **集成点**：
  - **memory-universe**：`LLMFallbackHandler.generateResponse` 整体放入 `runWithLLMCircuitBreaker`；`SoulOrchestrator` 内联 TTS 调用放入 `runWithTTSCircuitBreaker`，熔断时打日志并跳过合成。
- **验证**：`memory-universe` 下 `npx tsc --noEmit` 通过；`shared` 下 `jest --testPathPattern=CircuitBreakerClient` 通过。`npm run test:shared` 仍存在 1 个 property test suite 失败及 Jest 未退出（可能与 FallbackManager.property.test 或 opossum 定时器有关），待后续排查。
