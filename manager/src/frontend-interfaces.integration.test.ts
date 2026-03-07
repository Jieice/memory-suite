import * as fs from 'fs';
import * as path from 'path';

const APP_TSX_PATH = path.join(__dirname, '../../apps/web/src/App.tsx');
const SERVER_JS_PATH = path.join(__dirname, '../server.js');

const RETIRED_HTML_PATHS = [
  path.join(__dirname, '../public/index.html'),
  path.join(__dirname, '../public/training.html'),
  path.join(__dirname, '../public/tools.html'),
  path.join(__dirname, '../public/knowledge.html'),
  path.join(__dirname, '../public/creator-chat.html'),
];

function readFileContent(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

describe('Unified frontend interfaces', () => {
  test('apps/web should expose the unified operator routes', () => {
    const appContent = readFileContent(APP_TSX_PATH);
    const routes = ['/', '/runtime', '/training', '/jobs', '/tools', '/knowledge', '/creator-chat', '/overlays'];

    for (const route of routes) {
      expect(appContent).toContain(route);
    }
  });

  test('legacy manager html entrypoints should be retired from the repo', () => {
    for (const filePath of RETIRED_HTML_PATHS) {
      expect(fs.existsSync(filePath)).toBe(false);
    }
  });

  test('manager compatibility server should retire old html routes with unified hints', () => {
    const serverContent = readFileContent(SERVER_JS_PATH);
    const routes = ['/index.html', '/training.html', '/tools.html', '/knowledge.html', '/creator-chat.html'];

    for (const route of routes) {
      expect(serverContent).toContain(route);
    }
    expect(serverContent).toContain('manager static pages are retired');
    expect(serverContent).toContain('status(410)');
  });

  test('manager compatibility server should default compatibility proxies to the unified runtime', () => {
    const serverContent = readFileContent(SERVER_JS_PATH);
    expect(serverContent).toContain('http://127.0.0.1:8080');
    expect(serverContent).not.toMatch(/127\.0\.0\.1:400\d/);
  });
});
