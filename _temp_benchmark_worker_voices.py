import asyncio
import json
import statistics
import time

import aiohttp

WORKER_URL = 'http://127.0.0.1:9881/tts'
TEXT = '请给我一段适合 Live2D 播放的较长中文回答，用来验证 overlay 页面里语音真正开始播放的时机，以及字幕开始变化的时机。请保持自然、连贯，并带一点行动导向的总结。'
VOICES = [
    'zh-CN-XiaoxiaoNeural',
    'zh-CN-YunxiNeural',
    'zh-CN-XiaoyiNeural',
]
RUNS = 5


async def measure_worker(voice: str):
    payload = {
        'text': TEXT,
        'voice': voice,
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
                'voice': resp.headers.get('x-tts-voice'),
                'engine': resp.headers.get('x-tts-engine'),
                'first_byte_ms': round(first_byte_ms or -1, 1),
                'done_ms': round(done_ms, 1),
                'chunks': chunks,
                'bytes': total,
            }


async def main():
    results = []
    for voice in VOICES:
        runs = []
        for run in range(1, RUNS + 1):
            runs.append({'run': run, 'timing': await measure_worker(voice)})
        fb = [r['timing']['first_byte_ms'] for r in runs]
        done = [r['timing']['done_ms'] for r in runs]
        results.append({
            'voice': voice,
            'text_length': len(TEXT),
            'runs': runs,
            'summary': {
                'first_byte_min_ms': round(min(fb), 1),
                'first_byte_median_ms': round(statistics.median(fb), 1),
                'first_byte_max_ms': round(max(fb), 1),
                'done_min_ms': round(min(done), 1),
                'done_median_ms': round(statistics.median(done), 1),
                'done_max_ms': round(max(done), 1),
            },
        })
    print(json.dumps(results, ensure_ascii=False))


asyncio.run(main())
