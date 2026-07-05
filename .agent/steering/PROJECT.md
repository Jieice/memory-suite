# Project

## One-Liner

- `memory-suite` 是一个面向中文 AI 直播角色「忆（Yi）」的统一运行时：Rust daemon 做中枢，Electron/Web 做操作界面，Python 适配器处理语音输入输出。  
  Evidence: `README.md`, `apps/daemon/src/main.rs`, `apps/electron/main.cjs`, `python/tts/edge_tts_server.py`, `python/stt/faster_whisper_server.py`

## Why This Repo Exists

- 提供单机可运行的直播控制台、聊天编排、TTS/STT、Live2D 和 OBS overlay 联动，而不是把这些能力拆成多个独立项目。  
  Evidence: `README.md`, `start-electron.bat`, `scripts/start-electron.ps1`

## Owned Surfaces

| Surface | Path | Responsibility |
|---------|------|----------------|
| Rust daemon | `apps/daemon`, `crates/*` | HTTP/WS runtime、状态编排、网关、存储、媒体与 Python 适配器协调 |
| Electron shell | `apps/electron/main.cjs` | 桌面主窗口、Live2D 透明窗、窗口状态与启动/退出编排 |
| Web console | `apps/web` | React/Vite 运营台与内嵌桌面 UI |
| TTS adapter | `python/tts/edge_tts_server.py` | `edge-tts` FastAPI 语音合成服务 |
| STT adapter | `python/stt/faster_whisper_server.py` | `faster-whisper` FastAPI 语音转文本服务 |

## Stack and Commands

- Node.js `>=18`, Electron `43`, React `19`, Vite `7`.  
  Evidence: `package.json`, `apps/web/package.json`
- Rust workspace edition `2024`.  
  Evidence: `Cargo.toml`
- 关键入口命令：
  - `start-electron.bat`
  - `npm run unified:desktop`
  - `npm run unified:daemon`
  - `npm run unified:web:build`
  Evidence: `README.md`, `package.json`

## Decision Principles Already Visible In The Repo

### Observed

- 优先统一运行时：Web、Electron、TTS/STT 都围绕同一个本地 daemon 组织。  
  Evidence: `README.md`, `apps/daemon/src/main.rs`, `config/app.toml`
- 优先桌面启动体验：启动脚本负责端口选择、健康检查、缺失构建补齐、Electron 拉起。  
  Evidence: `scripts/start-electron.ps1`
- 优先可清理后台：专门维护后台进程 janitor，处理重复 Python 服务和 daemon。  
  Evidence: `scripts/service-janitor.ps1`

### Inferred

- 当前主产品形态是 Windows 桌面运营台 + Live2D/OBS 联动，浏览器模式属于次级入口。  
  Evidence: `README.md`, `start-electron.bat`, `apps/electron/main.cjs`

### Needs Confirmation

- STT 是否是默认生产链路，还是仅服务于本地麦克风聊天场景。  
  Evidence: `config/app.toml`, `README.md`
- `config/app.toml` 中的已填充 LLM 凭据是否是刻意提交的本地开发配置。  
  Evidence: `config/app.toml`

## Evidence Anchors

- `README.md`
- `package.json`
- `Cargo.toml`
- `config/app.toml`
- `start-electron.bat`
- `scripts/start-electron.ps1`
- `scripts/service-janitor.ps1`
- `apps/daemon/src/main.rs`
- `apps/electron/main.cjs`
- `apps/web/src/main.tsx`
- `python/tts/edge_tts_server.py`
- `python/stt/faster_whisper_server.py`
