import asyncio
import json
import time
import urllib.request
import urllib.error

import aiohttp

TEXT = "这是一段用于验证 edge_tts 流式输出的较长中文语音内容。我们希望确认首包会明显早于完整音频下载完成时间，并且在 live2d 语音队列里提前变成 ready。" * 2

async def measure_tts():
    url = 'http://127.0.0.1:9881/tts'
    payload = {
        'text': TEXT,
        'voice': 'edge-tts-zh',
        'rate': '1.0',
    }
    async with aiohttp.ClientSession() as session:
        start = time.perf_counter()
        async with session.post(url, json=payload) as resp:
            first_byte_ms = None
            total = 0
            async for chunk in resp.content.iter_chunked(4096):
                now = time.perf_counter()
                if first_byte_ms is None and chunk:
                    first_byte_ms = (now - start) * 1000
                total += len(chunk)
            done_ms = (time.perf_counter() - start) * 1000
            print(json.dumps({
                'status': resp.status,
                'content_type': resp.headers.get('content-type'),
                'engine': resp.headers.get('x-tts-engine'),
                'voice': resp.headers.get('x-tts-voice'),
                'first_byte_ms': round(first_byte_ms or 0, 1),
                'done_ms': round(done_ms, 1),
                'bytes': total,
            }, ensure_ascii=False))

asyncio.run(measure_tts())
