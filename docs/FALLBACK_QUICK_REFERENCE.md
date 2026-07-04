# Fallback Quick Reference

## Core Commands

```bat
start-electron.bat
关闭 Electron 桌面端并结束 daemon.exe
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
start-electron.bat
```

## Overlays

- Live2D: `http://127.0.0.1:8080/overlay/live2d`
- Danmaku: `http://127.0.0.1:8080/overlay/danmaku`

## Optional Sidecars

```bash
curl http://localhost:9881/voices
```

## Canonical Docs

- [UNIFIED_RUST_RUNTIME.md](./UNIFIED_RUST_RUNTIME.md)
- [FALLBACK_TROUBLESHOOTING.md](./FALLBACK_TROUBLESHOOTING.md)
