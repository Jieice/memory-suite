import json
import time
import urllib.request
import websocket
import threading

BASE = 'http://127.0.0.1:8080'
WS_URL = 'ws://127.0.0.1:8080/ws/overlay'
TEXT = '请给我一段适合 Live2D 播放的较长中文回答，用来验证 overlay 页面里语音真正开始播放的时机，以及字幕开始变化的时机。'
SESSION_ID = 'trace-chat-to-ready'


def post_json(url, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={'content-type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, json.loads(r.read().decode('utf-8'))


def get_json(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return r.status, json.loads(r.read().decode('utf-8'))


def ack(speech_id, status='completed'):
    req = urllib.request.Request(
        f'{BASE}/api/live2d/speech/{speech_id}/ack',
        data=json.dumps({'status': status, 'error': None}).encode('utf-8'),
        headers={'content-type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, json.loads(r.read().decode('utf-8'))


# drain old queue
for _ in range(20):
    _, payload = get_json(f'{BASE}/api/live2d/speech/next')
    item = payload.get('item')
    if not item:
        break
    ack(item['id'])

# prove empty before run
_, empty_check = get_json(f'{BASE}/api/live2d/speech/next')

started = time.perf_counter()
events = []
stop_flag = False


def mark(kind, **extra):
    events.append({
        't_ms': round((time.perf_counter() - started) * 1000, 1),
        'kind': kind,
        **extra,
    })


def ws_thread():
    ws = websocket.create_connection(WS_URL, timeout=10)
    ws.settimeout(0.2)
    try:
        while not stop_flag:
            try:
                msg = ws.recv()
            except Exception:
                continue
            if not msg:
                continue
            try:
                payload = json.loads(msg)
            except Exception:
                continue
            kind = payload.get('kind')
            if kind in {
                'speech_ready',
                'speech_started',
                'speech_completed',
                'speech_failed',
                'live2d_subtitle_updated',
                'live2d_emotion_updated',
            }:
                mark('ws:event', event_kind=kind, detail=payload.get('detail'), source=payload.get('source'))
    finally:
        ws.close()


thread = threading.Thread(target=ws_thread, daemon=True)
thread.start()

time.sleep(0.3)
mark('chat:request')
chat_status, chat_payload = post_json(
    f'{BASE}/api/chat',
    {'session_id': SESSION_ID, 'text': TEXT},
)
mark(
    'chat:response',
    status=chat_status,
    speech_status=chat_payload.get('speech', {}).get('status'),
    speech_audio_url=chat_payload.get('speech', {}).get('audio_url'),
    assistant_text=chat_payload.get('assistant_text'),
)

seen_item = None
for _ in range(120):
    _, payload = get_json(f'{BASE}/api/live2d/speech/next')
    item = payload.get('item')
    if item:
        seen_item = item
        mark(
            'next:item',
            speech_id=item.get('id'),
            item_status=item.get('status'),
            audio_url=(item.get('speech') or {}).get('audio_url'),
        )
        break
    else:
        mark('next:none')
    time.sleep(0.05)

if seen_item:
    ack(seen_item['id'])
    mark('ack:completed', speech_id=seen_item['id'])

time.sleep(0.5)
stop_flag = True
thread.join(timeout=1)

result = {
    'empty_check': empty_check,
    'chat_status': chat_status,
    'chat_speech_status': chat_payload.get('speech', {}).get('status'),
    'assistant_text': chat_payload.get('assistant_text'),
    'events': events,
}
print(json.dumps(result, ensure_ascii=False))
