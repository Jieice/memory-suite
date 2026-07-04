# Unified Rust Runtime

Memory Suite now runs through a single unified runtime path.

## What Exists Now

- `apps/daemon` is the single intended backend entrypoint
- `apps/electron` is the primary desktop operator shell
- `apps/web` is the React operator surface rendered inside Electron and reused by OBS overlays
- `config/app.toml` is the default runtime configuration
- `start-electron.bat` is the supported local operator entrypoint
- Browser launch paths are retired; normal operation starts from Electron

## Unified APIs Already Owned by Rust

- health, chat, and TTS dispatch
- runtime overview
- supervised adapter lifecycle
- live2d runtime state:
  - subtitle
  - emotion
  - model config
- danmaku source and connection state:
  - source save/readback
  - bootstrap resolution and upstream host persistence
  - connect/disconnect lifecycle
  - native Bilibili websocket session worker
  - native session heartbeat/error/close supervision
  - reconnect scheduling and retry state
  - decoded Bilibili event normalization and routing
- runtime and overlay websocket streams
- mock-safe danmaku gateway injection

## Current Command Set

```bash
npm run unified:test
npm run unified:types
npm run unified:web:build
npm run unified:bootstrap
npm run unified:daemon
npm run unified:desktop
npm run electron
```

## Current Intent

The Rust runtime is now more than a foundation slice:

- it owns the main persistence layer
- it owns the main operator web console
- it owns supervised runtime events
- it owns live2d runtime state
- it owns the Rust-native danmaku ingress path end-to-end
- it owns danmaku source configuration, bootstrap resolution, and connection posture
- it owns danmaku session supervision, reconnect timing, and state persistence
- it owns native Bilibili websocket probe, one-shot ingest, autostart, and long-lived session worker paths

## Current Boundaries

- Rust owns runtime orchestration, persistence, APIs, websocket streams, danmaku control, and live2d state.
- `apps/electron` owns the desktop shell, window state, and transparent Live2D floating window.
- `apps/web` owns the React renderer and OBS overlay pages.
- Python owns model-specific TTS adapters.

## 开播 Readiness 工作流

> 从"能启动"到"可正式开播"，只需一套固定工作流。

### 快速命令参考

```bash
# 1. 构建校验（离线可跑）
npm run unified:types        # 重新生成共享 API 类型
npm run unified:web:build    # 确认 web 构建干净
npm run readiness:test       # readiness 单元测试（4 用例，纯函数）

# 2. 启动
start-electron.bat           # Electron 控制台 + 透明 Live2D 浮窗

# 3. 运行面校验（需 daemon 在线）
npm run smoke                # 全链路 smoke（含 TTS adapter / overlay / chat）
npm run smoke:skip-chat      # smoke 但跳过 LLM 聊天（适合快速自检）
npm run smoke:quick          # 最快 smoke（仅核心 API，跳过 chat 和 overlay）

# 4. 故障排查
scripts/diagnose-services.bat
scripts/test-full-chain.bat
```

### 开播 Readiness 卡片

RuntimePage（`http://127.0.0.1:8080`）顶部显示实时 Readiness 卡片：

- **🚫 阻塞**：存在 blocking 门禁未通过（不可开播）
- **⚠️ 警告**：所有 blocking 通过，但存在值得关注的 warning
- **✅ 可开播**：所有门禁通过，可以正式开播

门禁判断以 RuntimePage 顶部 Readiness 卡片、`npm run readiness:test` 和 `npm run smoke` 为准。

## Electron Shell Notes

- Main console loads the React renderer with `?desktop=1`.
- Live2D floating window loads `/overlay/live2d?mode=pet&electron=1`.
- Live2D model assets are expected under `Liver2d/hiyori_zh-Hans/hiyori_pro/runtime`; `Liver2d/hiyori_pro_zh/runtime` remains a local compatibility mirror.
- Window bounds and floating-window toggles are saved in `runtime/electron-window-state.json`.
- `Ctrl+Alt+L` toggles the Live2D floating window.
- `Ctrl+Alt+T` toggles click-through.
