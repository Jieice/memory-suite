# Unified Runtime Control API Usage

This document replaces the old manager control API guide.

## Base URL

`http://127.0.0.1:8080`

## Operator-Controlled Surfaces

### Chat

```bash
curl http://localhost:8080/api/chat -X POST \
  -H "Content-Type: application/json" \
  -d '{"session_id":"control-doc","user_id":"operator","text":"hello"}'
```

### Live2D

```bash
curl http://localhost:8080/api/live2d/state

curl http://localhost:8080/api/live2d/subtitle -X POST \
  -H "Content-Type: application/json" \
  -d '{"text":"operator subtitle"}'

curl http://localhost:8080/api/live2d/emotion -X POST \
  -H "Content-Type: application/json" \
  -d '{"emotion":"happy"}'
```

### Danmaku

```bash
curl http://localhost:8080/api/danmaku/source
curl http://localhost:8080/api/danmaku/state

curl http://localhost:8080/api/gateway/danmaku -X POST \
  -H "Content-Type: application/json" \
  -d '{"session_id":"control-doc","user_id":"viewer","text":"test danmaku"}'
```

### TTS

```bash
curl http://localhost:8080/api/tts/speak -X POST \
  -H "Content-Type: application/json" \
  -d '{"session_id":"control-doc-tts","voice":"default","text":"hello"}'
```

## Runtime Streams

- `WS /ws/runtime`
- `WS /ws/overlay`

## Notes

- The old `/api/control/*` manager proxy surface is legacy material.
- The canonical operator surface is now the unified web UI in `apps/web`.
- For startup and cutover steps, see [UNIFIED_RUST_RUNTIME.md](./UNIFIED_RUST_RUNTIME.md) and [CUTOVER_CHECKLIST.md](./CUTOVER_CHECKLIST.md).
