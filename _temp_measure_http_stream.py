import asyncio
import json
import sys
import time
import aiohttp

URL = sys.argv[1]

async def main():
    async with aiohttp.ClientSession() as session:
        start = time.perf_counter()
        async with session.get(URL) as resp:
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
                'first_byte_ms': round(first_byte_ms or -1, 1),
                'done_ms': round(done_ms, 1),
                'chunks': chunks,
                'bytes': total,
                'content_type': resp.headers.get('content-type'),
            }, ensure_ascii=False))

asyncio.run(main())
