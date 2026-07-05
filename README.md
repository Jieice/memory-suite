# Memory Suite

A unified `Rust daemon + React/TypeScript web UI + Python TTS adapter` runtime powering **忆 (Yi)** — a Neuro-sama-style Chinese VTuber AI.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  apps/daemon                    │
│  Axum HTTP/WS server  ·  AppState               │
│  ┌──────────┐ ┌──────────┐ ┌─────────────────┐  │
│  │Orchestrat│ │Live2dSvc │ │  GatewayService │  │
│  │or + Persona Canon    │ │  (Danmaku/B站)  │  │
│  └──────────┘ └──────────┘ └─────────────────┘  │
│  ┌──────────┐ ┌──────────────────────────────┐  │
│  │TtsService│ │          RuntimeBus          │  │
│  └──────────┘ └──────────────────────────────┘  │
└────────────────────┬────────────────────────────┘
                     │ HTTP / WS
       ┌─────────────┴──────────────┐
       │                            │
  apps/electron          python/tts (edge-tts)
  apps/web + overlays    FastAPI adapter
```

### Workspace crates

| Crate | Role |
|-------|------|
| `crates/api-types` | Shared request/response types (ts-rs generated) |
| `crates/app-config` | `app.toml` loader |
| `crates/orchestrator` | LLM chat loop, persona canon, RuntimeBus, session summaries |
| `crates/gateway` | Danmaku/Bilibili protocol client |
| `crates/storage` | SQLite via sqlx (messages, memory, scene, runtime state) |
| `crates/media` | TTS pipeline, Live2D speech queue, chat response finalizer |
| `crates/python-adapters` | Python TTS adapter supervisor |
| `crates/telemetry` | tracing-subscriber init |

## Character — 忆 (Yi)

Persona canon: `data/memories/global/PERSONA_CANON.md`

Loaded at startup via `MEMORY_SUITE_PERSONA_CANON_PATH` env var or the default repo-relative path. Injected into every LLM system prompt.

**Neuro-sama parity: ~70%** — Phases 0–4 complete.

| Phase | Features |
|-------|----------|
| 0 | Persona canon, storage, orchestrator prompt, fallback stats, web controls |
| 1 | Short reaction layer, idle presence timer (60 s), post-reply follow-through, stream mode state machine |
| 2 | Drift detection (0%), user relationship awareness, session summary every 10 messages, consistency test suite |
| 3 | Program structure segments, recurring segments (tech_talk / casual_chat / quiz / roast), clip-first detection, community catchphrases |
| 4 | Scene event bus (`POST /api/scene/event`), autonomous scene commentary via TTS+Live2D, scene context injection, action suggestions (`GET /api/scene/suggest`) |

## Runtime Layout

```
apps/
  electron/       Electron desktop shell + transparent Live2D pet window
  daemon/          Rust binary — HTTP + WS server
  web/             React operator UI + OBS overlays
crates/            Rust library crates
python/
  tts/             edge-tts FastAPI server
config/
  app.toml         Main runtime config
data/
  memories/        Long-term memory and persona canon
runtime/           SQLite DB and data root (git-ignored)
docs/              Runtime docs and operator notes
```

## Quick Start

Electron desktop mode:

```bat
start-electron.bat
```

This starts the unified Rust daemon, opens the operator console in Electron, and creates a transparent always-on-top Live2D floating window.

Live2D assets are loaded from `Liver2d/hiyori_zh-Hans/hiyori_pro/runtime` with `Liver2d/hiyori_pro_zh/runtime` kept as a local compatibility mirror. `Liver2d/` is git-ignored because the model assets are large.

Electron shortcuts:

- `Ctrl+Alt+L`: show/hide the transparent Live2D floating window.
- `Ctrl+Alt+T`: toggle click-through for the Live2D floating window.

The Live2D floating window saves its size and position under `runtime/electron-window-state.json`. Drag the top edge of the transparent window to move it; drag the model itself to adjust the Live2D stage position.

Or manually:

```bash
# Start TTS adapter
cd python/tts && uvicorn edge_tts_server:app --port 9881

# Start daemon
cargo run -p daemon
```

## HTTP API

Base: `http://127.0.0.1:8080`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/chat` | Send chat message to Yi |
| GET | `/api/runtime/overview` | Runtime stats |
| GET | `/api/runtime/chat-latency` | Recent /api/chat stage timings |
| GET | `/api/runtime/adapters` | List Python adapter runs |
| POST | `/api/runtime/adapters/{id}/start` | Start a TTS adapter (`edge_tts` / `sovits`) |
| GET | `/api/knowledge/catalog` | Search profiles / memory / config artifacts |
| GET | `/api/sessions/{session_id}/messages` | Session message history |
| GET | `/api/tools/manifests` | List `data/tools` manifests |
| POST | `/api/tools/execute` | Execute a node tool |
| GET | `/api/tools/executions` | Recent tool executions |
| POST | `/api/tts/speak` | Speak text via TTS |
| GET | `/api/audio/{request_id}` | Fetch synthesized audio file |
| GET | `/api/live2d/state` | Live2D state |
| POST | `/api/live2d/subtitle` | Push subtitle |
| POST | `/api/live2d/emotion` | Trigger emotion |
| POST | `/api/live2d/config` | Update Live2D config |
| GET | `/api/live2d/speech/next` | Poll next speech item |
| POST | `/api/live2d/speech/{id}/ack` | Ack speech playback |
| GET/POST | `/api/danmaku/source` | Read / update danmaku source config |
| GET | `/api/danmaku/state` | Danmaku connection state |
| POST | `/api/danmaku/bootstrap` | Fetch danmaku bootstrap info |
| POST | `/api/danmaku/native-probe` | Probe upstream reachability |
| POST | `/api/danmaku/native-connect-once` | One-shot native connect |
| POST | `/api/danmaku/native-session/start` | Start supervised native session |
| POST | `/api/danmaku/disconnect` | Disconnect danmaku |
| POST | `/api/gateway/danmaku` | Inject a danmaku message (buffered batch) |
| GET | `/api/persona/state` | Current persona runtime state |
| POST | `/api/persona/config` | Update persona config |
| POST | `/api/scene/event` | Inject scene event |
| GET/POST | `/api/scene/context` | Read / set scene context |
| GET | `/api/scene/suggest` | Autonomous action suggestion |
| GET/POST | `/api/character/diary` | Read / generate character diary |
| GET | `/api/character/thoughts` | Generate inner monologue |
| GET | `/api/character/clips` | Clip candidates |
| POST | `/api/character/generate-short` | Generate short social content |
| GET/POST | `/api/character/mood` | Read / set mood |
| GET | `/api/character/energy` | Session energy level |
| POST | `/api/character/highlight-reel` | Generate stream highlight recap |
| GET | `/api/audience` | Active audience stats |
| POST | `/api/events/reaction` | Audience reaction event |
| GET | `/api/session/topics` | Tracked session topics |

**WebSocket streams:**
- `WS /ws/runtime` — runtime events
- `WS /ws/overlay` — overlay events
- `WS /ws/session/{session_id}` — per-session events

**OBS overlay pages:**
- `http://127.0.0.1:8080/overlay/live2d`
- `http://127.0.0.1:8080/overlay/danmaku`

**Operator UI:** `start-electron.bat` (Electron desktop shell)

## Config (`config/app.toml`)

```toml
[server]
host = "127.0.0.1"
port = 8080

[tts]
provider = "edge_tts"
endpoint = "http://127.0.0.1:9881"
chat_voice = "zh-CN-XiaoxiaoNeural"
speech_rate = "1.4"

[llm]
endpoint = "https://api.deepseek.com/v1/chat/completions"
model = "deepseek-chat"
```

## Key Docs

- [`docs/UNIFIED_RUST_RUNTIME.md`](docs/UNIFIED_RUST_RUNTIME.md) — runtime architecture
- [`docs/CONTROL_API_USAGE.md`](docs/CONTROL_API_USAGE.md) — HTTP API reference
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — deployment, health checks, troubleshooting
- [`docs/2026-03-12-live2d-neurosama-gap-summary.md`](docs/2026-03-12-live2d-neurosama-gap-summary.md) — Live2D / Neuro-sama gap analysis
