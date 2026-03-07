# Memory Suite

Memory Suite now runs as a single `Rust daemon + React/TypeScript web UI + Python adapter` system.

## Runtime Layout

- Backend: `apps/daemon`
- Web UI and OBS overlays: `apps/web`
- Shared runtime crates: `crates/*`
- Python model/tooling boundary: `python/`
- Config: `config/app.toml`
- Startup: `start-unified.bat`

## Quick Start

```bat
start-unified.bat
```

Verification flow:

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

## Main Docs

- `docs/UNIFIED_RUST_RUNTIME.md`
- `docs/CUTOVER_CHECKLIST.md`
- `docs/legacy/README.md`
