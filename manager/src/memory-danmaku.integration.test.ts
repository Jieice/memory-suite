import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

const CONFIG_PATH = path.join(__dirname, '../../memory-danmaku/config.json');
const BRIDGE_PATH = path.join(__dirname, '../../memory-danmaku/bridge.js');
const ENV_PATH = path.join(__dirname, '../../.env');

function readJson(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function extractPort(url: string): number | null {
  const m = url.match(/:(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

describe('memory-danmaku Integration Tests', () => {
  describe('Config defaults', () => {
    let config: Record<string, unknown>;

    beforeAll(() => {
      config = readJson(CONFIG_PATH);
    });

    test('config should define non-empty chat/tts/live2d URLs', () => {
      const fields = ['memoryChatUrl', 'live2dSubtitleUrl', 'ttsUrl', 'audioPlayUrl'];
      for (const field of fields) {
        const value = String(config[field] || '');
        expect(value.length).toBeGreaterThan(0);
        expect(value).toMatch(/^https?:\/\//);
      }
    });

    test('chat should route through manager, media through local services', () => {
      const memoryChatUrl = String(config.memoryChatUrl || '');
      const ttsUrl = String(config.ttsUrl || '');
      const subtitleUrl = String(config.live2dSubtitleUrl || '');
      const audioPlayUrl = String(config.audioPlayUrl || '');

      expect(extractPort(memoryChatUrl)).toBe(8080);
      expect(extractPort(ttsUrl)).toBe(4014);
      expect(extractPort(subtitleUrl)).toBe(4002);
      expect(extractPort(audioPlayUrl)).toBe(4002);
    });
  });

  describe('Bridge routing logic', () => {
    let bridgeCode: string;

    beforeAll(() => {
      bridgeCode = readText(BRIDGE_PATH);
    });

    test('chat primary should be manager and fallback should be memory-universe', () => {
      expect(bridgeCode).toContain('const CHAT_URL = cfg.memoryChatUrl || `${WEB_MANAGER_URL}/api/chat`');
      expect(bridgeCode).toContain('const FALLBACK_CHAT_URL = `${MEMORY_UNIVERSE_URL}/api/chat`');
    });

    test('memory-universe health check should use /health', () => {
      expect(bridgeCode).toContain('`${MEMORY_UNIVERSE_URL}/health`');
      expect(bridgeCode).not.toContain('`${MEMORY_UNIVERSE_URL}/api/status`');
    });

    test('danmaku style batch learn should call manager endpoint', () => {
      expect(bridgeCode).toContain('`${WEB_MANAGER_URL}/api/danmaku-style/learn/batch`');
    });
  });

  describe('Environment compatibility', () => {
    test('env should define expected ports', () => {
      const envText = readText(ENV_PATH);
      expect(envText).toContain('MANAGER_PORT=8080');
      expect(envText).toContain('MEMORY_UNIVERSE_PORT=4005');
      expect(envText).toContain('TTS_SERVICE_PORT=4014');
      expect(envText).toContain('LIVE2D_SERVICE_PORT=4002');
      expect(envText).toContain('DANMAKU_SERVICE_PORT=4003');
    });
  });

  describe('Property checks', () => {
    test('chat URL format remains valid for any port', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 65535 }), (port: number) => {
          const url = `http://127.0.0.1:${port}/api/chat`;
          expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/chat$/);
        }),
        { numRuns: 100 }
      );
    });
  });
});
