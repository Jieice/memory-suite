import asyncio
import json
import time
import edge_tts

TEXT = "这是一段用于排查 edge_tts 首包延迟的较长中文内容。我们需要知道真正的第一个音频 chunk 是什么时候从 edge_tts.stream() 里出来的。" * 2
VOICE = "zh-CN-XiaoxiaoNeural"

async def main():
    start = time.perf_counter()
    first_audio_ms = None
    first_event_ms = None
    audio_chunks = 0
    audio_bytes = 0
    event_types = []

    communicate = edge_tts.Communicate(TEXT, VOICE, rate="+0%")
    async for chunk in communicate.stream():
        now_ms = (time.perf_counter() - start) * 1000
        chunk_type = chunk.get("type")
        if first_event_ms is None:
            first_event_ms = now_ms
        if len(event_types) < 12:
            event_types.append(chunk_type)
        if chunk_type == "audio":
            if first_audio_ms is None:
                first_audio_ms = now_ms
            data = chunk.get("data") or b""
            audio_chunks += 1
            audio_bytes += len(data)

    done_ms = (time.perf_counter() - start) * 1000
    print(json.dumps({
        "voice": VOICE,
        "first_event_ms": round(first_event_ms or -1, 1),
        "first_audio_ms": round(first_audio_ms or -1, 1),
        "done_ms": round(done_ms, 1),
        "audio_chunks": audio_chunks,
        "audio_bytes": audio_bytes,
        "event_types": event_types,
    }, ensure_ascii=False))

asyncio.run(main())
