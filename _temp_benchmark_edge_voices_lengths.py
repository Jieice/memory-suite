import asyncio
import json
import time

import edge_tts

VOICES = [
    'zh-CN-XiaoxiaoNeural',
    'zh-CN-XiaoyiNeural',
    'zh-CN-YunjianNeural',
    'zh-CN-YunxiNeural',
]
TEXTS = {
    'short': '请简单说明当前系统状态。',
    'medium': '请给我一段适合 Live2D 播放的中文回答，用来验证语音首包和字幕开始变化的时机。',
    'long': '请给我一段适合 Live2D 播放的较长中文回答，用来验证 overlay 页面里语音真正开始播放的时机，以及字幕开始变化的时机。请保持自然、连贯，并带一点行动导向的总结。',
}
RUNS_PER_CASE = 2


async def measure_direct(text: str, voice: str):
    start = time.perf_counter()
    first_event_ms = None
    first_audio_ms = None
    event_types = []
    audio_chunks = 0
    audio_bytes = 0

    communicate = edge_tts.Communicate(text, voice, rate='+0%')
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


async def main():
    results = []
    for voice in VOICES:
        for text_name, text in TEXTS.items():
            runs = []
            for run in range(1, RUNS_PER_CASE + 1):
                runs.append({
                    'run': run,
                    'timing': await measure_direct(text, voice),
                })
            results.append({
                'voice': voice,
                'text_name': text_name,
                'text_length': len(text),
                'runs': runs,
            })
    print(json.dumps(results, ensure_ascii=False))


asyncio.run(main())
