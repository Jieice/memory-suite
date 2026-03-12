from playwright.sync_api import sync_playwright
import json
import sys
import time

URL = 'http://127.0.0.1:8080/overlay/live2d'
CHAT_URL = 'http://127.0.0.1:8080/api/chat'
TEXT = '请给我一段适合 Live2D 播放的较长中文回答，用来验证 overlay 页面是否能正常收到并消费语音队列。'

console_logs = []
page_errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.on('console', lambda msg: console_logs.append(f'{msg.type}: {msg.text}'))
    page.on('pageerror', lambda err: page_errors.append(str(err)))

    page.goto(URL, wait_until='networkidle', timeout=30000)
    before_status = page.locator('#speech-status').inner_text()
    before_subtitle = page.locator('#subtitle').inner_text()

    page.evaluate(
        """
        async ({ chatUrl, text }) => {
          const response = await fetch(chatUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session_id: 'playwright-overlay-session', text })
          });
          return await response.json();
        }
        """,
        {"chatUrl": CHAT_URL, "text": TEXT},
    )

    deadline = time.time() + 8
    observed = []
    while time.time() < deadline:
        status = page.locator('#speech-status').inner_text()
        subtitle = page.locator('#subtitle').inner_text()
        observed.append({'status': status, 'subtitle': subtitle})
        if 'playing' in status.lower() or 'error' in status.lower() or 'lip-only' in status.lower():
            break
        page.wait_for_timeout(250)

    after_status = page.locator('#speech-status').inner_text()
    after_subtitle = page.locator('#subtitle').inner_text()
    page.screenshot(path='D:/AI/memory-suite/_temp_overlay_check.png', full_page=True)
    browser.close()

result = json.dumps({
    'before_status': before_status,
    'before_subtitle': before_subtitle,
    'after_status': after_status,
    'after_subtitle': after_subtitle,
    'observed': observed[-8:],
    'console_logs': console_logs[-20:],
    'page_errors': page_errors,
    'screenshot': 'D:/AI/memory-suite/_temp_overlay_check.png',
}, ensure_ascii=False)

sys.stdout.buffer.write(result.encode('utf-8'))
sys.stdout.buffer.write(b'\n')
