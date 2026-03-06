import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

const MEMORY_LIVE2D_APP_PATH = path.join(__dirname, '../../memory-live2d/app.js');
const ENV_PATH = path.join(__dirname, '../../.env');

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function readEnvFile(): Map<string, string> {
  const envMap = new Map<string, string>();
  const content = readFile(ENV_PATH);
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    envMap.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return envMap;
}

describe('memory-live2d Integration Tests', () => {
  describe('Service health routing', () => {
    let appCode: string;

    beforeAll(() => {
      appCode = readFile(MEMORY_LIVE2D_APP_PATH);
    });

    test('should use manager health route for memory-universe', () => {
      expect(appCode).toContain('/api/services/memory-universe/health');
      expect(appCode).toContain('MEMORY_SUITE_MANAGER_URL');
    });

    test('fallback should target memory-universe health, not legacy 3100', () => {
      expect(appCode).toContain(':4005');
      expect(appCode).toContain('/health');
      expect(appCode).not.toContain('localhost:3100');
    });

    test('audio/subtitle polling should use local live2d server path', () => {
      expect(appCode).toContain('this.serverUrl');
      expect(appCode).toContain('/api/audio/current');
    });
  });

  describe('Environment compatibility', () => {
    test('env should define current manager + service ports', () => {
      const envVars = readEnvFile();
      expect(envVars.get('MANAGER_PORT')).toBe('8080');
      expect(envVars.get('MEMORY_UNIVERSE_PORT')).toBe('4005');
      expect(envVars.get('LIVE2D_SERVICE_PORT')).toBe('4002');
      expect(envVars.get('TTS_SERVICE_PORT')).toBe('4014');
      expect(envVars.get('DANMAKU_SERVICE_PORT')).toBe('4003');
    });
  });

  describe('Property checks', () => {
    test('manager health URL format remains valid', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 65535 }), (port: number) => {
          const url = `http://127.0.0.1:${port}/api/services/memory-universe/health`;
          expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/services\/memory-universe\/health$/);
        }),
        { numRuns: 100 }
      );
    });
  });
});
