# Repo Map

## One-Sentence Model

- 本仓库是一个以本地 Rust daemon 为中枢的 AI 直播桌面系统，外接 Electron 运营台、React 控制台、Live2D/OBS overlay，以及 Python 语音适配器。  
  Evidence: `README.md`, `apps/daemon/src/main.rs`, `apps/electron/main.cjs`

## What This Repository Owns

- 中文 VTuber「忆（Yi）」的本地运行时与运营台。  
  Evidence: `README.md`
- Chat/TTS/STT/Live2D/弹幕/scene/persona/memory 的统一编排。  
  Evidence: `README.md`, `config/app.toml`

## Runtime Surfaces

| Surface | Path | Role | Entry Points | Notes |
|---------|------|------|--------------|-------|
| Daemon | `apps/daemon`, `crates/*` | HTTP/WS runtime 中枢 | `cargo run -p daemon`, `npm run unified:daemon` | 端口默认 `8080` |
| Electron shell | `apps/electron/main.cjs` | 桌面主窗口 + Live2D 透明窗 | `start-electron.bat`, `npm run unified:desktop` | 依赖本地 `daemon.exe` 与 `electron.cmd` |
| Web console | `apps/web` | React/Vite 控制台 | `npm --prefix apps/web run build` | 可由 Electron 或浏览器承载 |
| Live2D overlay | runtime-served overlay | OBS / pet 模式显示 | `/overlay/live2d` | README 明确给出 overlay URL |
| Danmaku overlay | runtime-served overlay | OBS 弹幕层 | `/overlay/danmaku` | README 明确给出 overlay URL |
| TTS adapter | `python/tts/edge_tts_server.py` | 语音合成 | `uvicorn edge_tts_server:app --port 9881` | FastAPI |
| STT adapter | `python/stt/faster_whisper_server.py` | 语音识别 | Python FastAPI server | 默认 `9882` |

## Stack and Infrastructure

- Rust workspace, edition `2024`.  
  Evidence: `Cargo.toml`
- Electron `43` at root; React `19` + Vite `7` in `apps/web`.  
  Evidence: `package.json`, `apps/web/package.json`
- Python FastAPI adapters for speech IO.  
  Evidence: `python/tts/edge_tts_server.py`, `python/stt/faster_whisper_server.py`
- SQLite runtime persistence under `runtime/`.  
  Evidence: `config/app.toml`

## Commands That Work Today

- install: `npm --prefix apps/web install`  
  Evidence: `package.json`
- dev/desktop: `start-electron.bat`, `npm run unified:start`, `npm run unified:desktop`  
  Evidence: `README.md`, `package.json`
- build: `npm run unified:web:build`, `cargo build -p daemon`  
  Evidence: `package.json`, Rust workspace layout
- test: `npm test`, `npm run unified:test`, `npm run readiness:test`, `npm run smoke`  
  Evidence: `package.json`

## Apps, Packages, and Boundaries

- App surfaces live under `apps/`: `daemon`, `electron`, `web`.  
  Evidence: repo layout, `README.md`
- Core libraries live under `crates/`: `api-types`, `app-config`, `gateway`, `storage`, `orchestrator`, `python-adapters`, `media`, `telemetry`.  
  Evidence: `Cargo.toml`
- Python services live under `python/tts` and `python/stt`.  
  Evidence: repo layout

## External Systems and Integrations

- Bilibili / danmaku gateway.  
  Evidence: `README.md`
- OpenAI-compatible LLM endpoint configured in `config/app.toml`.  
  Evidence: `config/app.toml`
- `edge-tts` and `faster-whisper` speech stack.  
  Evidence: `python/tts/edge_tts_server.py`, `python/stt/faster_whisper_server.py`
- OBS overlay consumption of runtime-served pages.  
  Evidence: `README.md`

## Existing Conventions

### Observed

- 启动脚本负责健康检查、端口选择、缺失构建补齐和桌面拉起。  
  Evidence: `scripts/start-electron.ps1`
- 后台进程重复清理由 janitor 统一处理。  
  Evidence: `scripts/service-janitor.ps1`
- 运行数据、模型、Live2D 资产默认不入库。  
  Evidence: `.gitignore`

### Inferred

- Windows 是当前主开发/运行平台。  
  Evidence: `start-electron.bat`, `scripts/start-electron.ps1`

### Needs Confirmation

- STT 是否是默认主链路能力，还是仅在麦克风聊天场景下启用。  
  Evidence: `config/app.toml`, `README.md`
- 是否允许将真实凭据保存在 `config/app.toml`。  
  Evidence: `config/app.toml`

## Verification and Release Surfaces

- Rust tests via `npm run unified:test`.  
  Evidence: `package.json`
- Web readiness tests via Jest config `apps/web/jest.config.cjs`.  
  Evidence: `package.json`, `apps/web/jest.config.cjs`
- Smoke script for end-to-end checks via `scripts/smoke-test.ts`.  
  Evidence: `package.json`, `scripts/smoke-test.ts`

## Change-Relevant Hotspots

- `config/app.toml` — runtime wiring and provider configuration
- `scripts/start-electron.ps1` — startup orchestration
- `scripts/service-janitor.ps1` — duplicate process cleanup
- `apps/electron/main.cjs` — shell, Live2D window, shutdown behavior
- `apps/web/src/*` — operator UI
- `apps/daemon` + `crates/*` — runtime core

## Sources Read

- `README.md` - product identity, runtime topology, API/overlay surfaces
- `package.json` - root commands and runtime dependencies
- `.gitignore` - ignored runtime assets and local-state boundaries
- `.editorconfig` - repo text/file conventions
- `Cargo.toml` - Rust workspace boundaries and stack
- `config/app.toml` - runtime defaults and provider wiring
- `start-electron.bat` - desktop entrypoint
- `scripts/start-electron.ps1` - startup orchestration
- `scripts/service-janitor.ps1` - background process policy
- `apps/daemon/Cargo.toml` - daemon dependency boundary
- `apps/daemon/src/main.rs` - daemon entrypoint
- `apps/electron/main.cjs` - Electron shell runtime
- `apps/web/package.json` - web stack
- `apps/web/src/main.tsx` - web entrypoint
- `python/tts/edge_tts_server.py` - TTS adapter surface
- `python/stt/faster_whisper_server.py` - STT adapter surface
