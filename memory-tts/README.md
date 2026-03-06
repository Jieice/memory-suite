# Memory SoVITS-TTS Adapter

Node.js adapter that exposes a stable `/api/tts` interface for the suite and forwards synthesis to GPT-SoVITS (`/tts`).

## Endpoints

- `GET /health`
- `POST /api/tts`
- `GET /audio/:filename`
- `GET /api/voices`
- `GET /api/languages`
- `POST /api/cache/clear`
- `GET /api/cache/stats`

## Required Environment

- `TTS_SERVICE_PORT` (default `4014`)
- `TTS_SERVICE_HOST` (default `127.0.0.1`)
- `SOVITS_API_URL` (default `http://127.0.0.1:9880`)

## Recommended SoVITS Environment

- `SOVITS_TIMEOUT_MS=45000`
- `SOVITS_REF_AUDIO=` (absolute path recommended)
- `SOVITS_REF_TEXT=`
- `SOVITS_REF_LANGUAGE=zh`
- `SOVITS_TARGET_LANGUAGE=zh`
- `SOVITS_SPEED=1.0`
- `SOVITS_TEXT_SPLIT_METHOD=cut5`
- `SOVITS_BATCH_SIZE=1`
- `SOVITS_FRAGMENT_INTERVAL=0.3`
- `SOVITS_MEDIA_TYPE=wav`
- `SOVITS_STREAMING_MODE=false`
- `SOVITS_TOP_K=15`
- `SOVITS_TOP_P=1.0`
- `SOVITS_TEMPERATURE=1.0`

## GPT-SoVITS 版本建议

本 adapter 调用 GPT-SoVITS 的 HTTP API（默认 `http://127.0.0.1:9880`），与后端版本兼容即可。推荐后端版本：

| 版本 | 说明 | 推荐场景 |
|------|------|----------|
| **V2** | 多语言、语速/无参考/混合语种 | 通用 |
| **V4** | 修复 V3 金属音、原生 48k | 追求音质 |
| **V2Pro** | 性能优于 V4 | 低延迟、高并发 |

- 若使用 V2/V4/V2Pro，保持 `SOVITS_API_URL` 指向对应服务地址即可，adapter 无需改代码。
- 后端升级后若 API 路径或参数有变，可通过 `SOVITS_TTS_URL`、`SOVITS_REF_*` 等环境变量适配；遇兼容问题可查 [GPT-SoVITS 官方文档](https://github.com/RVC-Boss/GPT-SoVITS)。

## Notes

- Adapter response stays compatible with existing upper services (`audio_url`, `audioPath`, `duration`, `engine`).
- Set `SOVITS_REF_AUDIO` and `SOVITS_REF_TEXT` if your SoVITS runtime requires explicit reference per request.
- Keep SoVITS API bound to localhost unless you add authentication/reverse-proxy protection.
