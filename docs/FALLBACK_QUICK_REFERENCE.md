# Fallback Quick Reference

> Historical note: this file now serves as a unified runtime operator cheat sheet. The old multi-service fallback commands are retired.

## Core Commands

```bat
start-unified.bat
start-manager.bat
stop-all.bat
```

## Health and Runtime

```bash
curl http://localhost:8080/api/health
curl http://localhost:8080/api/runtime/overview
curl http://localhost:8080/api/live2d/state
curl http://localhost:8080/api/danmaku/state
```

## Chat and TTS

```bash
curl http://localhost:8080/api/chat -X POST \
  -H "Content-Type: application/json" \
  -d '{"session_id":"quick-ref","user_id":"test","text":"hello"}'

curl http://localhost:8080/api/tts/speak -X POST \
  -H "Content-Type: application/json" \
  -d '{"session_id":"quick-ref-tts","voice":"default","text":"hello"}'
```

## Verification

```bash
npm run unified:test
npm run unified:types
npm run unified:web:build
cmd /c "set MEMORY_SUITE_SKIP_SERVE=1&& start-unified.bat"
```

## Overlays

- Live2D: `http://127.0.0.1:8080/overlay/live2d`
- Danmaku: `http://127.0.0.1:8080/overlay/danmaku`

## Optional Sidecars

```bash
curl http://localhost:4007/health
curl http://localhost:3000/health
```

## Canonical Docs

- [UNIFIED_RUST_RUNTIME.md](./UNIFIED_RUST_RUNTIME.md)
- [CUTOVER_CHECKLIST.md](./CUTOVER_CHECKLIST.md)
- [legacy/README.md](./legacy/README.md)
