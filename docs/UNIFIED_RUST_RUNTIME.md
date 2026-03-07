# Unified Rust Runtime

Memory Suite now runs through a single unified runtime path.

## What Exists Now

- `apps/daemon` is the single intended backend entrypoint
- `apps/web` is the primary operator surface
- `config/app.toml` is the default runtime configuration
- `start-unified.bat` is the only supported local bootstrap path

## Unified APIs Already Owned by Rust

- health, chat, jobs, and TTS dispatch
- legacy import and runtime overview
- supervised adapter lifecycle
- live2d runtime state:
  - subtitle
  - emotion
  - model config
- danmaku source and connection state:
  - source save/readback
  - connect/disconnect lifecycle
  - protocol adapter supervision boundary
  - helper session callback supervision
  - reconnect scheduling and retry state
  - decoded helper event normalization and routing
- runtime and overlay websocket streams
- mock-safe danmaku gateway injection

## Current Command Set

```bash
npm run unified:test
npm run unified:types
npm run unified:web:build
npm run unified:bootstrap
npm run unified:daemon
npm run unified:import
```

## Current Intent

The Rust runtime is now more than a foundation slice:

- it owns the main persistence layer
- it owns the main operator web console
- it owns supervised runtime events
- it owns live2d runtime state
- it owns the first Rust danmaku ingress path
- it owns danmaku source configuration and connection posture
- it owns danmaku session supervision and reconnect timing
- it owns native Bilibili websocket probe, one-shot ingest, and long-lived session worker paths

The remaining work is not about defining the new architecture anymore. It is about retiring the last legacy operational dependencies and replacing protocol-specific behavior behind the Rust control plane.

## Current Boundaries

- Rust owns runtime orchestration, persistence, APIs, websocket streams, danmaku control, and live2d state.
- `apps/web` owns the operator UI and OBS overlay pages.
- Python owns model-specific adapters and training tooling.
- Historical specs remain under `docs/legacy/` only as archive material.
