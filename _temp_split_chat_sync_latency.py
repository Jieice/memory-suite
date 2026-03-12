import asyncio
import json
import time
import urllib.request
import aiohttp

BASE = 'http://127.0.0.1:8080'
WORKER_URL = 'http://127.0.0.1:9881/tts'
TEXT = '请给我一段适合 Live2D 播放的较长中文回答，用来验证 overlay 页面里语音真正开始播放的时机，以及字幕开始变化的时机。'


def post_json(url, payload, timeout=60):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={'content-type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode('utf-8'))


async def measure_stream(url, payload):
    async with aiohttp.ClientSession() as session:
        start = time.perf_counter()
        async with session.post(url, json=payload) as resp:
            first_byte_ms = None
            chunks = 0
            total = 0
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


chat_start = time.perf_counter()
chat_status, chat_payload = post_json(
    f'{BASE}/api/chat',
    {'session_id': 'split-sync-chat', 'text': TEXT},
)
chat_elapsed_ms = (time.perf_counter() - chat_start) * 1000
assistant_text = chat_payload.get('assistant_text') or ''

tts_speak_start = time.perf_counter()
tts_speak_status, tts_speak_payload = post_json(
    f'{BASE}/api/tts/speak',
    {'session_id': 'split-sync-chat-tts', 'text': assistant_text, 'voice': 'edge-tts-zh'},
)
tts_speak_elapsed_ms = (time.perf_counter() - tts_speak_start) * 1000

worker_payload = {
    'text': assistant_text,
    'voice': 'edge-tts-zh',
    'rate': '1.0',
}
worker_timing = asyncio.run(measure_stream(WORKER_URL, worker_payload))

print(json.dumps({
    'chat': {
        'status': chat_status,
        'elapsed_ms': round(chat_elapsed_ms, 1),
        'speech_status': chat_payload.get('speech', {}).get('status'),
        'audio_url': chat_payload.get('speech', {}).get('audio_url'),
        'assistant_text_length': len(assistant_text),
        'assistant_text': assistant_text,
    },
    'tts_speak': {
        'status': tts_speak_status,
        'elapsed_ms': round(tts_speak_elapsed_ms, 1),
        'response': tts_speak_payload,
    },
    'worker_tts': worker_timing,
}, ensure_ascii=False))
