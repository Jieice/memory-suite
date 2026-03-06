# Memory Suite 优化与升级建议（2025）

基于行业调研与当前代码结构整理的**可执行**优化与升级方向，供迭代参考。

---

## 一、行业与对标动态

### 1. AI VTuber 生态（2024–2025）

- **开源方案**：如 [AI-VTuber](https://github.com/open-llm-vtuber)、各 LLM 驱动方案普遍采用：
  - **多模型**：智谱、ChatGPT、Claude、ChatGLM 等
  - **多 TTS**：GPT-SoVITS、VITS、Bert-Vits2、VALL-E-X
  - **多数字人**：Live2D、Vtube Studio、UE5
  - **长短期记忆**：直接记忆 + 联想记忆
  - **知识层**：图数据库、向量库、知识图谱
- **工程趋势**：分离进程 + WebSocket 代理、Stream 流式响应、低硬件资源优化。

### 2. Neuro-sama / Vedal AI

- **Neuro SDK**（[VedalAI/neuro-sdk](https://github.com/VedalAI/neuro-sdk)）：MIT、WebSocket 协议，支持 Unity/Godot，可参考其协议与集成方式。
- 可评估：是否用 WebSocket 替代部分 HTTP 轮询、与游戏/外部客户端的对接方式。

---

## 二、架构与工程优化

### 2.1 Node/TypeScript 微服务（2024 最佳实践）

| 方向 | 建议 | 当前状态 | 优先级 |
|------|------|----------|--------|
| **服务发现 / 网关** | 明确 API 网关或服务注册（如 Consul/内存表），避免硬编码端口满天飞 | 端口在 .env，无统一注册 | 中 |
| **熔断器** | 关键依赖（LLM、TTS）已有超时与降级，可加 **Circuit Breaker**（如 opossum）防止雪崩 | 有超时与 Fallback | 高 |
| **异步通信** | 高吞吐场景可引入 **消息队列**（如 RabbitMQ/Redis Stream）做弹幕/事件缓冲 | 同步 HTTP | 低 |
| **缓存** | 对热数据（会话摘要、用户状态）做 **Redis 或内存缓存**，减轻 BrainNN/Memory 压力 | 未统一 | 中 |
| **日志与监控** | 集中日志（如 Winston + 文件/ELK）、**全链路 Trace**（请求 ID 贯穿 Manager → Universe → TTS） | 有 Prometheus/Grafana、分散 log | 中 |
| **容器化** | 各服务 **Dockerfile + docker-compose**，便于一键启动与资源限制 | 仅 bat 脚本 | 中 |

### 2.2 依赖与运行环境

- **Node**：README 要求 18+，建议根与各子项目 `package.json` 中统一 `"engines": { "node": ">=18.0.0" }`；**memory-tts** 当前为 `>=14.0.0`，建议改为 18+。
- **TypeScript**：保持 5.x，各子项目 tsconfig 建议统一 `target: "ES2022"` 或以上。
- **安全**：定期 `npm audit`，关键依赖（axios、express、dotenv）保持小版本升级。

---

## 三、LLM 与记忆系统升级

### 3.1 记忆与 RAG（2024–2025 实践）

- **分层记忆**：
  - **Working**：当前对话窗口
  - **Short-term**：会话内近期消息（你已有会话级状态）
  - **Long-term**：向量 + 稀疏 + 图检索（你已有记忆系统）
- **检索策略**：
  - 采用 **混合检索**：先便宜检索（关键词/稀疏），再按需向量/图扩展。
  - 可参考 **MemR3** 等“检索–反思–再答”闭环，减少无效向量查询。
- **知识图谱**：若已有实体关系，可做“按需子图”而非全图加载，降低延迟。
- **可观测**：为记忆检索加 **trace**（命中条数、延迟、模型），便于调参与成本控制。

### 3.2 编排与 Agent

- **LangGraph / LlamaIndex Agents**：若有复杂多步规划或工具调用，可引入编排层，与现有 BrainNN/Agent Core 做对接或逐步迁移。
- **流式输出**：Chat 接口建议支持 **SSE/Stream**，从首 token 到 TTS 的延迟会更平滑，体验更好。

---

## 四、TTS（memory-tts）优化

### 4.1 GPT-SoVITS 侧

- **版本**：若仍用旧版，可评估升级到 **V2/V3/V4**（多语言、24k/48k、V2Pro 性能更好）。
- **实时性**：
  - 与 TTS 服务之间可采用 **流式请求**（若 API 支持）：边生成边送 Live2D，降低首包延迟。
  - 对高频短句可做 **预生成/缓存**（如问候语、固定回复）。

### 4.2 服务端

- **memory-tts**：Node 版本建议与主项目统一到 18+；axios/express 等依赖可小幅升级并跑一遍测试。
- **限流与健康检查**：你已有 express-rate-limit，可加 `/health` 与 Manager 探活，便于自动重启或降级。

---

## 五、Live2D（memory-live2d）优化

- **Cubism Web 性能**（官方建议）：
  - 避免在每帧循环里调用 WebGL getter，改为应用侧缓存后传入。
  - 纹理使用 **Premultiplied Alpha**，`UNPACK_PREMULTIPLY_ALPHA_WEBGL = true`。
  - 模型：控制 **艺术网格数量、多边形数、变形器数量**；单对象关联参数尽量 ≤2，减少混合计算。
- **多 Canvas**：若多模型同页，注意 Cubism 5 Web R2+ 多 Canvas 的开销与浏览器 WebGL 数量限制。

---

## 六、弹幕与实时链路

- **memory-danmaku**：已用 bilibili-live-ws、WBI 签名，保持依赖更新即可。
- **端到端延迟**：从弹幕到首字/首音的时间可打点统计（Manager 收到 → Universe → LLM 首 token → TTS 首包 → Live2D），便于针对性优化。
- **流式**：若 LLM 支持流式，建议整条链路 **弹幕 → 流式 LLM → 流式 TTS（若支持）→ Live2D**，可显著提升“像在说话”的连贯感。

---

## 七、建议优先级汇总

| 优先级 | 项 | 说明 | 状态 |
|--------|----|------|------|
| **P0** | 熔断器 | 为 LLM/TTS 调用加 Circuit Breaker，防止连续失败拖垮服务 | ✅ 已完成 |
| **P0** | Chat 流式 | Manager/Universe 支持 LLM 流式输出并推进到 TTS/Live2D | ⬜ 未做 |
| **P1** | Node 18+ 统一 | 全仓库 engines 与 CI 统一到 Node 18+，memory-tts 升级 | ✅ 已完成 |
| **P1** | 记忆检索可观测 | 为 Memory 检索加 trace 与简单指标 | ⬜ 未做 |
| **P1** | GPT-SoVITS 版本 | 评估并升级到 V2/V4 或 V2Pro，改善音质与延迟 | ✅ 已补充说明（memory-tts README + .env.example） |
| **P2** | 请求 ID 全链路 | 从 Manager 生成 requestId，贯穿日志便于排查 | ✅ 已完成 |
| **P2** | Docker 化 | 各服务 Dockerfile + docker-compose，替代/补充 bat | ⬜ 未做 |
| **P2** | Live2D 性能 | 按 Cubism 文档检查网格与参数数量、WebGL 用法 | ⬜ 未做 |
| **P3** | 消息队列 | 高并发时用 Redis/RabbitMQ 缓冲弹幕与事件 | ✅ 已做（可选 Redis 队列，REDIS_URL + MANAGER_CHAT_USE_QUEUE=true） |
| **P3** | Neuro SDK 参考 | 若有游戏/外部客户端需求，可参考 Vedal Neuro SDK 协议 | ⬜ 未做 |

---

## 八、可立即执行的小改动

1. **根目录与 memory-tts**：在 `package.json` 中设置 `"engines": { "node": ">=18.0.0" }`。
2. **Manager 健康探活**：为 TTS、Universe、BrainNN 等依赖服务增加 `/health` 调用与状态展示。
3. **README**：在「环境要求」中明确写 Node 18+、Python 3.10+，并注明推荐 GPT-SoVITS 版本（如 V2/V4）。
4. **依赖**：在根目录执行 `npm audit`，对 high/critical 的漏洞做升级或缓解。

以上内容基于 2025 年初的公开资料与常见实践整理，具体实施时请结合你当前版本与排期做取舍。
