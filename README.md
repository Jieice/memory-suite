# Memory Suite

Memory Suite now runs on a unified `Rust daemon + TypeScript web UI + Python adapters` stack.

## Primary Runtime

- Backend: `apps/daemon`
- Web UI and overlays: `apps/web`
- Shared runtime crates: `crates/*`
- Default config: `config/app.toml`
- Default startup path: `start-unified.bat`
- Legacy compatibility alias: `start-manager.bat`

## Quick Start

```bat
start-unified.bat
```

Or run the cutover-safe verification flow:

```bash
npm run unified:test
npm run unified:types
npm run unified:web:build
npm run unified:import
npm run unified:bootstrap
```

## Default Local Surface

- Operator UI: `http://127.0.0.1:8080`
- Live2D overlay: `http://127.0.0.1:8080/overlay/live2d`
- Danmaku overlay: `http://127.0.0.1:8080/overlay/danmaku`

## Current Status

- Rust owns runtime orchestration, persistence, jobs, TTS dispatch, Live2D state, danmaku control plane, and native Bilibili websocket session supervision.
- Legacy `memory-danmaku/` has been retired from this branch.
- Old manager and historical docs remain only as reference material until their final retirement pass.

## Main Docs

- `docs/UNIFIED_RUST_RUNTIME.md`
- `docs/CUTOVER_CHECKLIST.md`
- `docs/LEGACY_RETIREMENT_MAP.md`
- `docs/legacy/README.md`
