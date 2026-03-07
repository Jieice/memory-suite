import * as fs from 'fs';
import * as path from 'path';

describe('Unified runtime legacy script retirement', () => {
  const scriptRoot = __dirname;

  it('should not keep 4005 as the default runtime endpoint in retained scripts', () => {
    const targets = [
      'functional-equivalence-test.ts',
      'migration-rollback.ts',
      'test-fallback-e2e.ts',
      'verify-nn-chain-complete.py'
    ];

    for (const target of targets) {
      const filePath = path.join(scriptRoot, target);
      const source = fs.readFileSync(filePath, 'utf8');

      expect(source).not.toContain('http://localhost:4005');
      expect(source).not.toContain('http://127.0.0.1:4005');
    }
  });
});
