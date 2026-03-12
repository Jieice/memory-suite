# Memory Suite

A single `Rust daemon + React/TypeScript web UI + Python TTS adapter` system powering 忆 (Yi) — a Neuro-sama-style VTuber AI.

## Runtime Layout

- Backend: `apps/daemon`
- Web UI and OBS overlays: `apps/web`
- Shared runtime crates: `crates/*`
- Python TTS adapter: `python/tts/`
- Config: `config/app.toml`
- Startup: `start-unified.bat`

## Quick Start

```bat
start-unified.bat
```

Verification:

```bash
npm run unified:test
npm run unified:types
npm run unified:web:build
```

## Default Local Surface

- Operator UI: `http://127.0.0.1:8080`
- Live2D overlay: `http://127.0.0.1:8080/overlay/live2d`
- Danmaku overlay: `http://127.0.0.1:8080/overlay/danmaku`

## Character

**忆 (Yi)** — persona defined in `data/memories/global/PERSONA_CANON.md`.

Neuro-sama parity estimate: ~70% (Phases 0–4 complete).

| Phase | Feature |
|-------|---------|
| 0 | Persona canon, storage, orchestrator prompt, fallback stats, web controls |
| 1 | Short reaction layer, idle presence timer, post-reply follow-through, stream mode state machine |
| 2 | Drift detection, user relationship awareness, session summary, consistency test suite |
| 3 | Program structure segments, recurring segments, clip-first detection, community catchphrases |
| 4 | Scene event bus (`/api/scene/event`), autonomous scene commentary, scene context injection, action suggestions (`/api/scene/suggest`) |

## Key Docs

- `docs/UNIFIED_RUST_RUNTIME.md` — runtime architecture
- `docs/UPGRADE_2026_SUMMARY.md` — 2026 migration summary
- `docs/2026-03-12-live2d-neurosama-gap-summary.md` — Live2D / Neuro-sama gap analysis
- `docs/plans/` — design plans and implementation notes
- `docs/CONTROL_API_USAGE.md` — HTTP control API reference
