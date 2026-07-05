# Voice STT Chat Redesign

**Bet:** 如果把当前“整段录完再一次性转写”的弱链路，重构为一个有状态机、可观测、可打断、低感知延迟的 Mic→STT→LLM→TTS/Live2D 通路，Memory Suite 的语音聊天才会从“能跑”变成“能用”。

## Bounded Goal

为 Memory Suite 当前口述语音→文字转写→模型处理→语音/Live2D 输出链路做一次完整审计，并产出一个可直接进入实现阶段的重设计合同，覆盖采集、分段、STT、模型接力、打断、反馈和观测面。

## Broader Intent

用户要的不是再加一层按钮或热键，而是把当前 Mic 聊天链路做成一条稳定、顺手、可解释的真链路，达到参考工具的交互水准，但服务于 Memory Suite 自己的直播对话场景。

## Work Scale and Work Shape

- **Scale:** capability-sized
- **Shape:** audit + redesign

## Selected Lenses

- product
- engineering
- runtime

## Target User or Stakeholder

- 主用户：直播操作者 / 主播本人
- 次用户：后续在此链路上做 UI、Runtime 和语音能力的实现者

## Constraints and Risks

### Constraints

- 当前仓库的真实主链是本地 daemon + Electron/Web + Python 语音适配器，不是系统级输入法产品。  
  Evidence: `apps/daemon/src/main.rs`, `apps/electron/main.cjs`, `python/stt/faster_whisper_server.py`, `python/tts/edge_tts_server.py`
- 现有 UI 偏好已经收敛到单一 `Mic 聊天` 开关，不应把设计退回到一套复杂热键配置中心。  
  Evidence: `apps/web/src/preferences.ts`, `apps/web/src/pages/SettingsPage.tsx`, `apps/web/src/pages/DashboardPage.tsx`
- 当前后端 STT API 只有批处理 `POST /api/stt/transcribe`，输入为整段 base64 音频，未提供流式 partial、VAD 事件、词级时间戳或置信度。  
  Evidence: `apps/daemon/src/routes/stt.rs`, `crates/api-types/src/lib.rs`, `crates/media/src/lib.rs`
- 当前前端虽然保留了 `transcribeMicAudio()` client helper，但仓库内已无 `getUserMedia` / `MediaRecorder` / 采集状态机实现。  
  Evidence: `apps/web/src/lib.ts`, targeted search in `apps/web/src`
- 当前 `/api/chat` 是“文本进 → orchestrator → finalize(TTS/Live2D) → 完整响应出”的同步链，语音输入没有独立会话态。  
  Evidence: `apps/daemon/src/routes/chat.rs`, `crates/media/src/lib.rs`

### Risks

- 如果继续沿用“录完整段 → 一次性上传 → 等完整文本 → 再发模型”的模式，体感延迟不会好，且无法做自然打断。
- 如果直接照搬 OpenLess / PushToTalk 这类系统级输入法产品，会把作用域带偏到“全局注入文本”，与当前直播控制台目标不一致。
- 如果不补 runtime 事件与状态机，只做 UI 微调，后续问题仍然无法定位：不知道卡在采集、VAD、STT、LLM、TTS 还是 overlay 播放。

## Required Outcome

本次 framing 产物必须把下面 7 个面讲清楚，并作为后续实现的唯一合同：

1. **当前链路审计图**
   - 从 Mic 打开、音频缓冲、发送 STT、转写结果、送入 `/api/chat`、进入 TTS/Live2D、到 OBS/overlay 可见/可听，完整列出当前真实链路。
   - 标出当前断点、假异步、假打断、无状态段。

2. **目标状态机**
   - 至少定义：`idle → arming → listening → speech_detected → finalizing_asr → thinking → speaking → interrupted / failed / cooldown`
   - 明确每个状态的进入条件、退出条件、UI 表现、runtime 事件和可取消点。

3. **输入模式设计**
   - 以简单 `Mic 聊天` 开关为前提，定义直播场景下的默认输入模式。
   - 必须明确是否采用：
     - 自动 VAD 收尾
     - 点击开始 / 自动收尾
     - 可选“长按说话”作为低优先兼容模式，还是彻底不做
   - 不能默认把复杂热键配置重新带回主 UI。

4. **STT 传输与分段策略**
   - 明确本项目采用：
     - 批处理 STT
     - 流式 STT
     - 或 “本地缓冲 + 短片段增量转写”的折中方案
   - 必须说明为什么，以及与当前 `faster_whisper` 本地适配器、OpenAI-compatible STT 的兼容边界。

5. **模型接力策略**
   - 定义 ASR 结果如何进入 LLM：
     - interim 仅用于 UI
     - final transcript 才触发 `/api/chat`
     - 是否允许“说到一半先预热模型”
   - 定义口语清洗、术语替换、主播口癖修正属于确定性规范化层还是 LLM 后处理层。

6. **打断与恢复设计**
   - 用户说话时，必须能打断当前 TTS/overlay 播放。
   - 新一轮语音开始时，必须明确取消：
     - 当前 Live2D speech queue
     - 当前 audio playback
     - 当前 session turn generation
   - 必须说明“打断成功”的判据，不允许只在后端标记取消、前端却继续播完整段。

7. **观测与验收面**
   - 为链路补最小必要事件与指标：
     - capture_started / capture_stopped
     - vad_open / vad_close
     - stt_partial / stt_final / stt_failed
     - llm_started / llm_completed / llm_failed
     - tts_enqueued / tts_started / tts_interrupted / tts_completed
   - 每一跳都要能在控制台或日志中定位延迟与失败点。

## Reference-Informed Design Direction

以下参考只用于抽取模式，不是功能照抄：

- **Handy**：强调“按触发键→说话→文字出现”的极简目标，以及本地离线优先。  
  Source: https://github.com/cjpais/Handy
- **VocoType CLI**：强调本地离线、低延迟、词典/AI 优化层分离。  
  Source: https://github.com/233stone/vocotype-cli
- **PushToTalk**：值得借的是流式转录、VAD、AGC、状态反馈和多引擎兜底，而不是把整个输入法产品面照搬进来。  
  Source: https://github.com/yyyzl/push-2-talk
- **OpenLess**：最值得借的是清晰状态机、流式/分阶段 pipeline、单实例/热键边沿管理、失败回退逻辑。  
  Source: https://github.com/Open-Less/openless
- **LazyTyper-releases**：当前仓库仅有 release 分发信息，缺少源码级架构参考，不作为设计主依据。  
  Source: https://github.com/oldcai/LazyTyper-releases

## Acceptance Criteria

1. SPEC 明确给出当前链路的真实节点与断点，且每个关键判断都能回指到仓库文件或参考来源。
2. SPEC 产出一个单一、连贯的目标链路，而不是把“系统级输入法”和“直播 Mic 聊天”两个产品混在一起。
3. SPEC 明确规定输入状态机、STT 策略、LLM 接力策略、打断策略和观测面，不留“实现时再看”的空洞块。
4. SPEC 保留用户已确定的方向：主设置只保留简单的 `Mic 聊天` 开关，不把复杂快捷键/按住说话配置重新塞回主流程。
5. SPEC 为下一阶段 planning 提供可拆 slice 的边界：前端采集、daemon 事件、STT service、chat orchestration、overlay 中断，各自可独立规划。

## Anti-Goals

- 不把本次工作 framing 成一个“系统级语音输入法”项目。
- 不把参考项目的全局热键、文本注入、样式市场等外围能力硬塞进当前直播链路。
- 不通过增加模板 prompt 或硬编码回复规则，掩盖链路本身的延迟与状态问题。
- 不只做 UI 按钮改名或设置项搬家。

## Assumptions

- 第一目标是优化 Memory Suite 自身的直播 Mic 聊天链路，而不是实现“任意应用光标注入文本”。
- 允许后续实现阶段把 STT 拆成“本地默认 + 云端可选”的双路径，但本次 SPEC 先统一行为合同。

## Evidence Anchors

- `apps/web/src/lib.ts`
- `apps/web/src/preferences.ts`
- `apps/web/src/pages/SettingsPage.tsx`
- `apps/web/src/pages/DashboardPage.tsx`
- `apps/daemon/src/routes/stt.rs`
- `apps/daemon/src/routes/chat.rs`
- `apps/daemon/src/state.rs`
- `crates/media/src/lib.rs`
- `crates/api-types/src/lib.rs`
- `python/stt/faster_whisper_server.py`
- `apps/web/overlays/live2d.html`
- `https://github.com/cjpais/Handy`
- `https://github.com/233stone/vocotype-cli`
- `https://github.com/yyyzl/push-2-talk`
- `https://github.com/Open-Less/openless`
- `https://github.com/oldcai/LazyTyper-releases`
