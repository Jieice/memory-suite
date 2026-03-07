/**
 * Legacy migration rollback helper.
 *
 * Rolling back to the split-service topology is retired. The supported recovery
 * strategy is restoring a saved worktree, branch, or git commit. This script
 * remains only to provide explicit guidance to anyone invoking the old entry.
 */

import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'migration-backups');

export interface RollbackState {
  phase: 'idle' | 'failed' | 'completed';
  startTime?: number;
  endTime?: number;
  currentStep: string;
  completedSteps: string[];
  errors: string[];
  warnings: string[];
}

export interface RollbackDecisionCriteria {
  errorRateThreshold: number;
  latencyThreshold: number;
  availabilityThreshold: number;
  functionalTestPassRate: number;
}

export const DEFAULT_ROLLBACK_CRITERIA: RollbackDecisionCriteria = {
  errorRateThreshold: 5,
  latencyThreshold: 5000,
  availabilityThreshold: 99,
  functionalTestPassRate: 80
};

let rollbackState: RollbackState = {
  phase: 'idle',
  currentStep: '',
  completedSteps: [],
  errors: [],
  warnings: []
};

const RETIRED_MESSAGE =
  'Retired: rollback to the old split-service architecture is no longer supported. Restore a git commit/worktree snapshot instead.';

export function getRollbackState(): RollbackState {
  return { ...rollbackState };
}

export function resetRollbackState(): void {
  rollbackState = {
    phase: 'idle',
    currentStep: '',
    completedSteps: [],
    errors: [],
    warnings: []
  };
}

export async function checkRollbackNeeded(
  _criteria: RollbackDecisionCriteria = DEFAULT_ROLLBACK_CRITERIA
): Promise<{
  needed: boolean;
  reasons: string[];
  metrics: {
    errorRate?: number;
    avgLatency?: number;
    availability?: number;
    functionalTestPassRate?: number;
  };
}> {
  return {
    needed: false,
    reasons: [RETIRED_MESSAGE],
    metrics: {}
  };
}

export async function createRollbackBackup(): Promise<{
  success: boolean;
  backupPath?: string;
  error?: string;
}> {
  return {
    success: false,
    error: RETIRED_MESSAGE
  };
}

export async function executeRollback(): Promise<{
  success: boolean;
  state: RollbackState;
}> {
  const startTime = Date.now();
  rollbackState = {
    phase: 'failed',
    startTime,
    endTime: Date.now(),
    currentStep: 'Rollback retired',
    completedSteps: [],
    errors: [RETIRED_MESSAGE],
    warnings: [
      'Use git history or a saved worktree snapshot if you need to inspect or restore the legacy topology.'
    ]
  };

  console.error(RETIRED_MESSAGE);
  return {
    success: false,
    state: getRollbackState()
  };
}

export function listRollbackBackups(): {
  backups: Array<{
    path: string;
    timestamp: number;
    date: string;
    files: string[];
  }>;
} {
  const backups: Array<{
    path: string;
    timestamp: number;
    date: string;
    files: string[];
  }> = [];

  if (!fs.existsSync(BACKUP_DIR)) {
    return { backups };
  }

  const dirs = fs
    .readdirSync(BACKUP_DIR)
    .filter(entry => entry.startsWith('rollback-backup-'))
    .map(entry => path.join(BACKUP_DIR, entry))
    .filter(entry => fs.statSync(entry).isDirectory());

  for (const dir of dirs) {
    try {
      const manifestPath = path.join(dir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      backups.push({
        path: dir,
        timestamp: manifest.timestamp,
        date: new Date(manifest.timestamp).toISOString(),
        files: manifest.files || []
      });
    } catch {
      // Ignore malformed historical backup manifests.
    }
  }

  return { backups: backups.sort((left, right) => right.timestamp - left.timestamp) };
}

export async function restoreFromBackup(_backupPath: string): Promise<{
  success: boolean;
  error?: string;
}> {
  return {
    success: false,
    error: RETIRED_MESSAGE
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const listBackups = args.includes('--list') || args.includes('-l');

  if (listBackups) {
    const { backups } = listRollbackBackups();
    console.log('\nLegacy rollback backups:\n');
    if (backups.length === 0) {
      console.log('No historical rollback backups found.');
    } else {
      for (const backup of backups) {
        console.log(`${backup.date}`);
        console.log(`  Path: ${backup.path}`);
        console.log(`  Files: ${backup.files.join(', ')}`);
      }
    }
    process.exit(0);
  }

  executeRollback().then(result => {
    process.exit(result.success ? 0 : 1);
  });
}
