from playwright.sync_api import sync_playwright
import json
import sys

URL = 'http://127.0.0.1:8080/overlay/live2d'
CHAT_URL = 'http://127.0.0.1:8080/api/chat'
TEXT = '请给我一段适合 Live2D 播放的较长中文回答，用来验证 overlay 页面里语音真正开始播放的时机，以及字幕开始变化的时机。'

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        args=['--autoplay-policy=no-user-gesture-required'],
    )
    page = browser.new_page()

    page.add_init_script(
        """
        (() => {
          const timeline = [];
          const startedAt = performance.now();
          const push = (kind, data = {}) => {
            timeline.push({
              t_ms: Number((performance.now() - startedAt).toFixed(1)),
              kind,
              ...data,
            });
          };
          window.__overlayTimeline = timeline;
          window.__overlayPush = push;

          const originalFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const input = args[0];
            const url = typeof input === 'string' ? input : input?.url;
            push('fetch:start', { url });
            try {
              const resp = await originalFetch(...args);
              push('fetch:end', { url, status: resp.status });
              return resp;
            } catch (error) {
              push('fetch:error', { url, message: String(error) });
              throw error;
            }
          };

          const OriginalAudio = window.Audio;
          function WrappedAudio(...args) {
            const audio = new OriginalAudio(...args);
            const src = () => audio.currentSrc || audio.src || '';
            push('audio:create', { src: src() });
            [
              'loadstart',
              'loadedmetadata',
              'loadeddata',
              'canplay',
              'canplaythrough',
              'play',
              'playing',
              'pause',
              'waiting',
              'stalled',
              'suspend',
              'ended',
              'error',
            ].forEach((eventName) => {
              audio.addEventListener(eventName, () => {
                push(`audio:${eventName}`, {
                  src: src(),
                  readyState: audio.readyState,
                  networkState: audio.networkState,
                  currentTime: Number((audio.currentTime || 0).toFixed(3)),
                });
              });
            });
            return audio;
          }
          WrappedAudio.prototype = OriginalAudio.prototype;
          window.Audio = WrappedAudio;

          const originalPlay = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play = function (...args) {
            push('audio.play:call', {
              src: this.currentSrc || this.src || '',
              readyState: this.readyState,
              networkState: this.networkState,
            });
            const result = originalPlay.apply(this, args);
            Promise.resolve(result).then(
              () => push('audio.play:resolved', {
                src: this.currentSrc || this.src || '',
                readyState: this.readyState,
                currentTime: Number((this.currentTime || 0).toFixed(3)),
              }),
              (error) => push('audio.play:rejected', {
                src: this.currentSrc || this.src || '',
                message: String(error),
              }),
            );
            return result;
          };

          document.addEventListener('DOMContentLoaded', () => {
            const statusEl = document.getElementById('speech-status');
            const subtitleEl = document.getElementById('subtitle');
            if (statusEl) {
              push('status:init', { text: statusEl.textContent || '' });
              new MutationObserver(() => {
                push('status:change', { text: statusEl.textContent || '' });
              }).observe(statusEl, { childList: true, subtree: true, characterData: true });
            }
            if (subtitleEl) {
              push('subtitle:init', { text: subtitleEl.textContent || '' });
              new MutationObserver(() => {
                push('subtitle:change', { text: subtitleEl.textContent || '' });
              }).observe(subtitleEl, { childList: true, subtree: true, characterData: true });
            }
          });
        })();
        """
    )

    console_logs = []
    page_errors = []
    page.on('console', lambda msg: console_logs.append(f'{msg.type}: {msg.text}'))
    page.on('pageerror', lambda err: page_errors.append(str(err)))

    page.goto(URL, wait_until='networkidle', timeout=30000)
    page.mouse.click(10, 10)

    chat_result = page.evaluate(
        """
        async ({ chatUrl, text }) => {
          const t0 = performance.now();
          window.__overlayPush('chat:request', { textLength: text.length });
          const response = await fetch(chatUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session_id: 'playwright-overlay-timing', text })
          });
          const json = await response.json();
          window.__overlayPush('chat:response', {
            status: response.status,
            elapsed_ms: Number((performance.now() - t0).toFixed(1)),
            speech_status: json?.speech?.status || null,
            audio_url: json?.speech?.audio_url || null,
          });
          return {
            status: response.status,
            elapsed_ms: Number((performance.now() - t0).toFixed(1)),
            speech_status: json?.speech?.status || null,
            audio_url: json?.speech?.audio_url || null,
          };
        }
        """,
        {"chatUrl": CHAT_URL, "text": TEXT},
    )

    page.wait_for_timeout(8000)

    timeline = page.evaluate("window.__overlayTimeline")
    final_status = page.locator('#speech-status').inner_text()
    final_subtitle = page.locator('#subtitle').inner_text()
    page.screenshot(path='D:/AI/memory-suite/_temp_overlay_timing.png', full_page=True)
    browser.close()

result = json.dumps({
    'chat_result': chat_result,
    'final_status': final_status,
    'final_subtitle': final_subtitle,
    'timeline': timeline,
    'console_logs': console_logs[-40:],
    'page_errors': page_errors,
    'screenshot': 'D:/AI/memory-suite/_temp_overlay_timing.png',
}, ensure_ascii=False)

sys.stdout.buffer.write(result.encode('utf-8'))
sys.stdout.buffer.write(b'\n')
