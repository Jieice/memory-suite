# Operations Guide

Deployment, health checks, degradation model, and troubleshooting for the unified Rust runtime.

## Degradation Model

The system fails soft from a single unified control plane:

- The Rust daemon is the only operator-facing backend; the web UI and overlays talk only to `http://127.0.0.1:8080`.
- Optional Python sidecars (TTS adapters) may degrade independently — the daemon keeps its API surface stable and queueing/runtime metadata remain in SQLite even when adapters fail.
- Recovery means restarting the unified runtime or restoring a known-good git/worktree snapshot — never reviving retired standalone services (`4002`/`4003`/`4005`, `memory-live2d/`, `memory-danmaku/`).

## Deployment

Target layout:

- Runtime entrypoint: `start-electron.bat`
- Operator UI: `http://127.0.0.1:8080`
- Optional TTS sidecar: `http://127.0.0.1:9881`

Build and verify before starting:

```bash
npm run unified:test        # cargo test across workspace crates
npm run unified:types       # regenerate apps/web/src/generated/api.ts
npm run unified:web:build   # build the operator UI
```

Check ports are free, then start:

```bat
netstat -ano | findstr :8080
netstat -ano | findstr :9881
start-electron.bat
```

## Health Checks

```bash
curl http://localhost:8080/api/health
curl http://localhost:8080/api/runtime/overview
curl http://localhost:8080/api/live2d/state
curl http://localhost:8080/api/danmaku/state
```

Chat and TTS probes:

```bash
curl http://localhost:8080/api/chat -X POST \
  -H "Content-Type: application/json" \
  -d '{"session_id":"ops-probe","user_id":"test","text":"hello"}'

curl http://localhost:8080/api/tts/speak -X POST \
  -H "Content-Type: application/json" \
  -d '{"session_id":"ops-probe-tts","voice":"default","text":"hello"}'
```

Overlays:

- Live2D: `http://127.0.0.1:8080/overlay/live2d`
- Danmaku: `http://127.0.0.1:8080/overlay/danmaku`

Optional sidecar:

```bash
curl http://localhost:9881/voices
```

## Troubleshooting

### Runtime not starting

- Run `start-electron.bat`; if bootstrap fails, fix the first failing step before retrying.
- Verify Rust toolchain, Node.js, npm, and Python are available.
- Port 8080 in use: stop the occupying process or set `MEMORY_SUITE_PORT`.

### Web UI missing

- Run `npm --prefix apps/web run build` and confirm `apps/web/dist/` exists, then restart.

### Danmaku not updating

- Check `GET /api/danmaku/state`.
- Use the runtime page to confirm source config, bootstrap, connect state, and native session state.
- Verify upstream reachability through the native probe controls.

### Live2D overlay not updating

- Check `GET /api/live2d/state` and open `http://127.0.0.1:8080/overlay/live2d`.
- Confirm `/ws/overlay` traffic is present after subtitle/emotion updates.

### TTS missing

- Check `POST /api/tts/speak`; if you depend on the Python sidecar, confirm `http://127.0.0.1:9881/voices`.

### Diagnostics

```bash
npm run smoke
scripts\diagnose-services.bat
node scripts/test-latency.mjs
```

## Recovery

1. Check `GET /api/health`, then `GET /api/runtime/overview`.
2. Check sidecar health only if the failing feature depends on it.
3. Close the Electron desktop shell and end `daemon.exe`, then run `start-electron.bat`.
4. If the runtime still fails, restore a known-good git/worktree snapshot.

## Related Docs

- [UNIFIED_RUST_RUNTIME.md](./UNIFIED_RUST_RUNTIME.md) — runtime architecture
- [CONTROL_API_USAGE.md](./CONTROL_API_USAGE.md) — HTTP API reference
