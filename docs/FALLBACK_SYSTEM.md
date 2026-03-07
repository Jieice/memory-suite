# Unified Runtime Fallback Model

This document replaces the old split-service fallback architecture note.

## Current Principle

The system should fail soft from a single unified control plane:

- Rust daemon stays as the only operator-facing backend
- optional Python sidecars may degrade independently
- the web UI and overlays continue to talk only to `http://127.0.0.1:8080`

## What “Fallback” Means Now

- If a Python sidecar is unavailable, the Rust daemon keeps its API surface stable
- operator state remains readable through:
  - `/api/health`
  - `/api/runtime/overview`
  - `/api/live2d/state`
  - `/api/danmaku/state`
- queueing and runtime metadata remain in SQLite even when adapters fail

## Current Operator Recovery Path

1. Check `GET /api/health`
2. Check `GET /api/runtime/overview`
3. Check sidecar health only if the failing feature depends on it
4. Restart with `stop-all.bat` then `start-unified.bat`
5. If needed, restore from git/worktree snapshot instead of reviving the retired multi-service stack

## Non-Goals

- No rollback to `4002` / `4003` / `4005`
- No reactivation of `memory-live2d/` or `memory-danmaku/`
- No separate operator control plane outside the Rust daemon

## Related Docs

- [FALLBACK_TROUBLESHOOTING.md](./FALLBACK_TROUBLESHOOTING.md)
- [FALLBACK_DEPLOYMENT_GUIDE.md](./FALLBACK_DEPLOYMENT_GUIDE.md)
- [UNIFIED_RUST_RUNTIME.md](./UNIFIED_RUST_RUNTIME.md)
