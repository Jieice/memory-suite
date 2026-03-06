import * as fs from 'fs';
import * as path from 'path';

const WEIGHTS_DIR = path.join(__dirname, '..', 'data', 'models');
const WEIGHTS_PATH = path.join(WEIGHTS_DIR, 'policy-nn-weights.json');
const BACKUP_PATH = path.join(WEIGHTS_DIR, 'policy-nn-weights.backup.json');

async function rollbackOneClick(): Promise<void> {
  console.log('[rollback] restoring weights from backup');

  if (!fs.existsSync(BACKUP_PATH)) {
    throw new Error(`Backup not found: ${BACKUP_PATH}`);
  }

  if (!fs.existsSync(WEIGHTS_DIR)) {
    fs.mkdirSync(WEIGHTS_DIR, { recursive: true });
  }

  fs.copyFileSync(BACKUP_PATH, WEIGHTS_PATH);
  console.log(`[rollback] restored: ${WEIGHTS_PATH}`);
}

if (require.main === module) {
  rollbackOneClick().catch(error => {
    console.error('[rollback] failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { rollbackOneClick };
