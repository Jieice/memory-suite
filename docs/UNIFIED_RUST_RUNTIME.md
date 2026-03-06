# Unified Rust Runtime

This branch now carries the first usable replacement for the old multi-process manager stack.

## What Exists Now

- `Cargo.toml` workspace for the unified runtime
- `apps/daemon` single-process Rust backend with:
  - `GET /api/health`
  - `POST /api/chat`
  - `POST /api/tts/speak`
  - `POST /api/jobs/train`
  - `POST /api/jobs/eval`
  - `POST /api/import/legacy`
  - `GET /api/runtime/overview`
  - `GET /api/runtime/adapters`
  - `GET /api/jobs`
  - `GET /api/sessions/:id/messages`
  - `GET /ws/session/:id`
  - `GET /ws/runtime`
  - `GET /overlay/live2d`
  - `GET /overlay/danmaku`
- `crates/api-types` shared Rust/TS API definitions
- `crates/app-config` TOML + environment override loader
- `crates/storage` SQLite-backed persistence for:
  - messages
  - jobs with execution metadata
  - supervised adapter runs
  - TTS requests with dispatch metadata
  - imported legacy memory/config artifacts
- `crates/orchestrator` with session fanout and runtime event bus
- `crates/jobs` with supervised adapter startup and train/eval execution tracking
- `crates/media` with TTS queue-to-dispatch flow
- `apps/web` unified TypeScript/React operator console
- `start-unified.bat` bootstrapper for type generation, web build, runtime directory prep, and daemon startup
- `config/app.toml` as the default local runtime config

## Commands

```bash
npm run unified:test
npm run unified:types
npm run unified:web:install
npm run unified:web:build
npm run unified:bootstrap
npm run unified:daemon
npm run unified:import
```

## Current Intent

This is beyond the foundation batch, but not final cutover yet:

- the unified daemon owns the new API and runtime supervision path
- the web console now has a dedicated runtime page and no longer depends on legacy manager pages
- train/eval jobs are dispatched through supervised adapters
- legacy import is available from both CLI and web UI
- old directories still exist only as migration/reference material

## Remaining Cutover Work

- replace remaining legacy operational habits with the unified startup path
- complete final adapter behavior for real model scripts and long-running workloads
- retire old service entrypoints after operator validation
