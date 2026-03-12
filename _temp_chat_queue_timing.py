import json
import time
import urllib.request

CHAT_URL = 'http://127.0.0.1:8080/api/chat'
NEXT_URL = 'http://127.0.0.1:8080/api/live2d/speech/next'
TEXT = '请给我一段较长的中文回答，用来验证 Live2D 语音队列是否会在完整 TTS 完成前提前 ready，并尽快开始播放。'

def post_json(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
        return r.status, json.loads(body.decode('utf-8'))

def get_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        body = r.read()
        return r.status, json.loads(body.decode('utf-8'))

start = time.perf_counter()
status, chat = post_json(CHAT_URL, {'session_id': 'timing-session', 'text': TEXT})
chat_ms = (time.perf_counter() - start) * 1000

next_item = None
next_ready_ms = None
poll_start = time.perf_counter()
for _ in range(100):
    _, payload = get_json(NEXT_URL)
    item = payload.get('item')
    if item:
        next_item = item
        next_ready_ms = (time.perf_counter() - poll_start) * 1000
        break
    time.sleep(0.1)

print(json.dumps({
    'chat_status': status,
    'chat_elapsed_ms': round(chat_ms, 1),
    'chat_speech_status': chat.get('speech', {}).get('status'),
    'chat_audio_url': chat.get('speech', {}).get('audio_url'),
    'next_ready_ms_after_chat': round(next_ready_ms or -1, 1),
    'next_item_status': (next_item or {}).get('status'),
    'next_item_id': (next_item or {}).get('id'),
    'next_audio_url': ((next_item or {}).get('speech') or {}).get('audio_url'),
}, ensure_ascii=False))
