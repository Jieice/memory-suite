import asyncio
import json
import time

import aiohttp
import edge_tts

VOICE = 'zh-CN-XiaoxiaoNeural'
TEXT = '请给我一段适合 Live2D 播放的较长中文回答，用来验证 overlay 页面里语音真正开始播放的时机，以及字幕开始变化的时机。operator, acknowledged. Next step: convert it into a concrete action with owner, deadline, and success criteria.'
WORKER_URL = 'http://127.0.0.1:9881/tts'
RUNS = 3


async def measure_direct(text: str):
    start = time.perf_counter()
    first_event_ms = None
    first_audio_ms = None
    audio_chunks = 0
    audio_bytes = 0
    event_types = []

    communicate = edge_tts.Communicate(text, VOICE, rate='+0%')
    async for chunk in communicate.stream():
        now_ms = (time.perf_counter() - start) * 1000
        chunk_type = chunk.get('type')
        if first_event_ms is None:
            first_event_ms = now_ms
        if len(event_types) < 12:
            event_types.append(chunk_type)
        if chunk_type == 'audio':
            if first_audio_ms is None:
                first_audio_ms = now_ms
            data = chunk.get('data') or b''
            audio_chunks += 1
            audio_bytes += len(data)

    done_ms = (time.perf_counter() - start) * 1000
    return {
        'first_event_ms': round(first_event_ms or -1, 1),
        'first_audio_ms': round(first_audio_ms or -1, 1),
        'done_ms': round(done_ms, 1),
        'audio_chunks': audio_chunks,
        'audio_bytes': audio_bytes,
        'event_types': event_types,
    }


async def measure_worker(text: str):
    payload = {
        'text': text,
        'voice': 'edge-tts-zh',
        'rate': '1.0',
    }
    async with aiohttp.ClientSession() as session:
        start = time.perf_counter()
        async with session.post(WORKER_URL, json=payload) as resp:
            first_byte_ms = None
            total = 0
            chunks = 0
            async for chunk in resp.content.iter_chunked(4096):
                now_ms = (time.perf_counter() - start) * 1000
                if first_byte_ms is None and chunk:
                    first_byte_ms = now_ms
                if chunk:
                    chunks += 1
                    total += len(chunk)
            done_ms = (time.perf_counter() - start) * 1000
            return {
                'status': resp.status,
                'content_type': resp.headers.get('content-type'),
                'engine': resp.headers.get('x-tts-engine'),
                'voice': resp.headers.get('x-tts-voice'),
                'first_byte_ms': round(first_byte_ms or -1, 1),
                'done_ms': round(done_ms, 1),
                'chunks': chunks,
                'bytes': total,
            }


async def main():
    runs = []
    for i in range(1, RUNS + 1):
        direct = await measure_direct(TEXT)
        worker = await measure_worker(TEXT)
        runs.append({
            'run': i,
            'direct': direct,
            'worker': worker,
        })

    summary = {
        'voice': VOICE,
        'text_length': len(TEXT),
        'runs': runs,
    }
    print(json.dumps(summary, ensure_ascii=False))


asyncio.run(main())
