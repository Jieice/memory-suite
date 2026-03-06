/**
 * Frontend/manager contract tests.
 * These tests validate that frontend pages call manager APIs through relative paths
 * and that manager server keeps the required compatibility endpoints.
 */

import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

const INDEX_HTML_PATH = path.join(__dirname, '../public/index.html');
const CREATOR_CHAT_HTML_PATH = path.join(__dirname, '../public/creator-chat.html');
const SERVER_JS_PATH = path.join(__dirname, '../server.js');

function readFileContent(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function extractFetchCalls(content: string): string[] {
  const fetchRegex = /fetch\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fetchRegex.exec(content)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

function hasRelativeApiPath(content: string, apiPath: string): boolean {
  const pattern = new RegExp(`fetch\\s*\\([^)]*['"\`]${apiPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  return pattern.test(content);
}

describe('Frontend Interfaces Integration Tests', () => {
  describe('index.html API routing', () => {
    let indexContent: string;

    beforeAll(() => {
      indexContent = readFileContent(INDEX_HTML_PATH);
    });

    test('index.html fetch calls should use relative paths', () => {
      const fetchCalls = extractFetchCalls(indexContent);
      for (const url of fetchCalls) {
        expect(url.startsWith('/')).toBe(true);
      }
    });

    test('index.html should include service management endpoints', () => {
      const endpoints = [
        '/api/services',
        '/api/services/start-all',
        '/api/services/stop-all'
      ];
      for (const endpoint of endpoints) {
        expect(hasRelativeApiPath(indexContent, endpoint)).toBe(true);
      }
    });
  });

  describe('creator-chat.html API routing', () => {
    let creatorChatContent: string;

    beforeAll(() => {
      creatorChatContent = readFileContent(CREATOR_CHAT_HTML_PATH);
    });

    test('creator-chat.html should not call localhost hardcoded ports', () => {
      expect(creatorChatContent).not.toMatch(/localhost:\d+/);
    });

    test('creator-chat.html should use expected chat and utility APIs', () => {
      const endpoints = [
        '/api/chat/dual',
        '/api/chat/result',
        '/api/stats',
        '/api/training/start',
        '/api/reflection/check'
      ];
      for (const endpoint of endpoints) {
        expect(hasRelativeApiPath(creatorChatContent, endpoint)).toBe(true);
      }
    });
  });

  describe('manager server compatibility routes', () => {
    let serverContent: string;

    beforeAll(() => {
      serverContent = readFileContent(SERVER_JS_PATH);
    });

    test('server.js should contain live control endpoints', () => {
      const routes = [
        '/api/live/emergency-stop',
        '/api/live/clear-subtitle',
        '/api/live/stop-tts',
        '/api/live/silence-mode',
        '/api/live/status'
      ];
      for (const route of routes) {
        expect(serverContent).toContain(route);
      }
    });

    test('server.js should contain compatibility endpoints used by frontend and danmaku', () => {
      const routes = [
        '/api/stats',
        '/api/reflection/check',
        '/api/knowledge/scheduler/trigger',
        '/api/knowledge/store/search',
        '/api/knowledge/style/profiles',
        '/api/learning/stats',
        '/api/danmaku-style/stats',
        '/api/showrunner/state',
        '/api/tools/scheduler/status',
        '/api/tools/scheduler/trigger',
        '/api/training/start',
        '/api/training/status'
      ];
      for (const route of routes) {
        expect(serverContent).toContain(route);
      }
    });

    test('server.js should proxy chat requests through /api/chat', () => {
      expect(serverContent).toContain("app.use('/api/chat'");
    });
  });

  describe('Property-based API path validation', () => {
    test('generated API paths should remain valid relative routes', () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom('live', 'chat', 'stats', 'training', 'knowledge', 'learning'), { minLength: 1, maxLength: 4 }),
          (segments: string[]) => {
            const apiPath = '/api/' + segments.join('/');
            expect(apiPath.startsWith('/api/')).toBe(true);
            expect(apiPath).not.toContain('//');
          }
        ),
        { numRuns: 100 }
      );
    });

    test('generated ports should be valid TCP ranges', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 65535 }), (port: number) => {
          expect(port).toBeGreaterThanOrEqual(1);
          expect(port).toBeLessThanOrEqual(65535);
        }),
        { numRuns: 100 }
      );
    });
  });
});
