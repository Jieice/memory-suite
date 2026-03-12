import asyncio
import json
import sys
import time
import aiohttp

URL = sys.argv[1]
TEXT = "这是一段用于验证新 worker /tts 首包行为的较长中文内容。我们希望确认首个 HTTP 音频块是否会早于完整下载完成。" * 2

async def main():
    payload = {
        'text': TEXT,
        'voice': 'edge-tts-zh',
        'rate': '1.0',
    }
    async with aiohttp.ClientSession() as session:
        start = time.perf_counter()
        async with session.post(URL, json=payload) as resp:
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
            print(json.dumps({
                'url': URL,
                'status': resp.status,
                'engine': resp.headers.get('x-tts-engine'),
                'voice': resp.headers.get('x-tts-voice'),
                'first_byte_ms': round(first_byte_ms or -1, 1),
                'done_ms': round(done_ms, 1),
                'chunks': chunks,
                'bytes': total,
                'content_type': resp.headers.get('content-type'),
            }, ensure_ascii=False))

asyncio.run(main())
