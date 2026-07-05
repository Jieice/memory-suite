# Requirements

## Hard Constraints

- Node.js 运行时最低版本为 `18`。  
  Evidence: `package.json`
- 核心运行时是 Rust workspace，edition 固定为 `2024`。  
  Evidence: `Cargo.toml`
- 默认端口约束已经编码进配置与适配器：
  - daemon `8080`
  - TTS `9881`
  - STT `9882`
  Evidence: `config/app.toml`, `python/tts/edge_tts_server.py`, `python/stt/faster_whisper_server.py`
- Electron 桌面链依赖本地 `daemon.exe`、`electron.cmd` 与 PowerShell 启动脚本；不是纯浏览器启动仓库。  
  Evidence: `start-electron.bat`, `scripts/start-electron.ps1`
- Web 构建产物必须可落到 `apps/web/dist`，否则桌面启动脚本会补跑安装与构建。  
  Evidence: `scripts/start-electron.ps1`

## Invariants

- 启动/退出流程必须能处理重复后台服务，至少覆盖 `daemon`、`edge_tts`、`flaresolverr`、`faster_whisper`。  
  Evidence: `scripts/service-janitor.ps1`
- 运行期数据和大体积资产默认不进 Git，包括 `runtime/`、`Liver2d/`、本地模型/缓存目录。  
  Evidence: `.gitignore`
- 影响主链路的改动需要兼顾 daemon、Electron、Web console 与 Live2D/OBS overlay 的联动。  
  Evidence: `README.md`, `apps/electron/main.cjs`, `apps/web/src/main.tsx`

## Non-Goals

- 首次 onboarding 不引入 roadmap phases。  
  Evidence: `.codex/skills/auto-onboard/SKILL.md`, `.codex/skills/auto-onboard/templates/ROADMAP.md`

## Planning Blockers

- `config/app.toml` 已包含实际远端 LLM 配置与密钥样式值；后续涉及配置、发布或协作前，需要明确凭据管理策略。  
  Evidence: `config/app.toml`
- 是否需要正式支持非 Windows 桌面主链尚不明确；如果需要，会直接改变后续实现与验证方式。  
  Evidence: `start-electron.bat`, `scripts/start-electron.ps1`

## Evidence Anchors

- `package.json`
- `Cargo.toml`
- `config/app.toml`
- `.gitignore`
- `README.md`
- `start-electron.bat`
- `scripts/start-electron.ps1`
- `scripts/service-janitor.ps1`
- `apps/electron/main.cjs`
- `apps/web/src/main.tsx`
- `python/tts/edge_tts_server.py`
- `python/stt/faster_whisper_server.py`
