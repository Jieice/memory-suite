# Fallback Troubleshooting

> Historical note: the old troubleshooting matrix for `4005`/`4002`/`4003` is retired. Use this guide for the unified runtime on `8080`.

## Quick Diagnosis

### 1. Runtime Health

```bash
curl http://localhost:8080/api/health
curl http://localhost:8080/api/runtime/overview
curl http://localhost:8080/api/live2d/state
curl http://localhost:8080/api/danmaku/state
```

### 2. Optional Sidecars

```bash
curl http://localhost:3000/health
```

### 3. Chat Probe

```bash
curl http://localhost:8080/api/chat -X POST \
  -H "Content-Type: application/json" \
  -d '{"session_id":"troubleshooting","user_id":"test","text":"hello"}'
```

## Common Issues

### Unified Runtime Not Starting

- Run `start-electron.bat`
- If bootstrap fails, fix the first failing step before retrying
- Verify Rust toolchain, Node.js, npm, and Python are available

### Web UI Missing

- Run `npm --prefix apps/web run build`
- Confirm `apps/web/dist/` exists
- Restart `start-electron.bat`

### Danmaku Not Updating

- Check `GET /api/danmaku/state`
- Use the runtime page to confirm source config, bootstrap, connect state, and native session state
- If needed, verify upstream reachability through the native probe controls

### Live2D Overlay Not Updating

- Check `GET /api/live2d/state`
- Open `http://127.0.0.1:8080/overlay/live2d`
- Confirm `/ws/overlay` traffic is present after subtitle/emotion updates

### TTS Missing

- Check `POST /api/tts/speak`
- If you depend on the Python sidecar, confirm `http://127.0.0.1:3000/health`

## Logs and Diagnostics

```bash
npm run smoke
scripts\\diagnose-services.bat
scripts\\test-latency.mjs
```

## Recovery

- `关闭 Electron 桌面端并结束 daemon.exe`
- `start-electron.bat`
- If the runtime still fails, restore a known-good git/worktree snapshot instead of trying to revive the retired split-service topology
