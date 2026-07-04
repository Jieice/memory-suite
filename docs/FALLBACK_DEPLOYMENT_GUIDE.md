# Fallback Deployment Guide

## Current Deployment Target

- Runtime entrypoint: `start-electron.bat`
- Operator UI: `http://127.0.0.1:8080`
- Health endpoint: `GET /api/health`
- Runtime overview: `GET /api/runtime/overview`
- Optional sidecars:
  - TTS adapter: `http://127.0.0.1:9881`

## Pre-Deployment Checklist

- `cargo test -p api-types -p app-config -p storage -p orchestrator -p gateway -p python-adapters -p media -p daemon`
- `cargo run -p api-types --bin export_web`
- `npm --prefix apps/web run build`
- `start-electron.bat`

## Deployment Steps

### 1. Prepare Host

```bash
mkdir -p runtime
netstat -ano | findstr :8080
netstat -ano | findstr :9881
```

### 2. Build and Verify

```bash
npm run unified:test
npm run unified:types
npm run unified:web:build
```

The unified runtime no longer has a pre-start migration step.

### 3. Start Runtime

```bat
start-electron.bat
```

### 4. Validate Runtime

```bash
curl http://localhost:8080/api/health
curl http://localhost:8080/api/runtime/overview
curl http://localhost:8080/api/live2d/state
curl http://localhost:8080/api/danmaku/state
curl http://localhost:8080/api/chat -X POST \
  -H "Content-Type: application/json" \
  -d '{"session_id":"deploy-guide","user_id":"test","text":"hello"}'
```

### 5. Overlay Checks

```bash
start http://127.0.0.1:8080/overlay/live2d
start http://127.0.0.1:8080/overlay/danmaku
```

## Rollback Guidance

Rollback to earlier unified-runtime snapshots is preferred in this branch.

If you need recovery:

- restore a known-good git commit
- switch back to an earlier worktree/branch snapshot
- restore runtime data backups under `runtime/` or `data/migration-backups/` if needed

## Related Docs

- [UNIFIED_RUST_RUNTIME.md](./UNIFIED_RUST_RUNTIME.md)
- [FALLBACK_QUICK_REFERENCE.md](./FALLBACK_QUICK_REFERENCE.md)
