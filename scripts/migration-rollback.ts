/**
 * Migration Rollback Procedures
 * 
 * Provides rollback functionality for the NN-LLM separation migration.
 * Allows reverting from split services back to monolithic architecture.
 * 
 * Requirements: 6.4
 */

import * as fs from 'fs';
import * as path from 'path';
import { httpGet, httpPost } from '../shared/httpClient';

// Service URLs
const DECISION_SERVICE_URL =
  process.env.DECISION_SERVICE_URL ||
  process.env.MEMORY_UNIVERSE_URL ||
  'http://localhost:4005';
const GENERATION_SERVICE_URL =
  process.env.GENERATION_SERVICE_URL ||
  process.env.BRAINNN_URL ||
  'http://localhost:4007';
const WEB_MANAGER_URL = process.env.WEB_MANAGER_URL || 'http://localhost:8080';

// Paths
const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'migration-backups');
const CONFIG_BACKUP_DIR = path.join(DATA_DIR, 'config-backups');

export interface RollbackState {
  phase: 'idle' | 'checking' | 'backing_up' | 'rolling_back' | 'verifying' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
  currentStep: string;
  completedSteps: string[];
  errors: string[];
  warnings: string[];
}

export interface RollbackDecisionCriteria {
  errorRateThreshold: number;      // Max acceptable error rate (%)
  latencyThreshold: number;        // Max acceptable latency (ms)
  availabilityThreshold: number;   // Min acceptable availability (%)
  functionalTestPassRate: number;  // Min functional test pass rate (%)
}

export const DEFAULT_ROLLBACK_CRITERIA: RollbackDecisionCriteria = {
  errorRateThreshold: 5,           // 5% error rate triggers rollback consideration
  latencyThreshold: 5000,          // 5 second latency triggers rollback consideration
  availabilityThreshold: 99,       // 99% availability required
  functionalTestPassRate: 80       // 80% functional tests must pass
};

let rollbackState: RollbackState = {
  phase: 'idle',
  currentStep: '',
  completedSteps: [],
  errors: [],
  warnings: []
};

/**
 * Get current rollback state
 */
export function getRollbackState(): RollbackState {
  return { ...rollbackState };
}

/**
 * Reset rollback state
 */
export function resetRollbackState(): void {
  rollbackState = {
    phase: 'idle',
    currentStep: '',
    completedSteps: [],
    errors: [],
    warnings: []
  };
}

/**
 * Update rollback state
 */
function updateState(updates: Partial<RollbackState>): void {
  rollbackState = { ...rollbackState, ...updates };
}

/**
 * Add completed step
 */
function completeStep(step: string): void {
  rollbackState.completedSteps.push(step);
  console.log(`✅ ${step}`);
}

/**
 * Add error
 */
function addError(error: string): void {
  rollbackState.errors.push(error);
  console.error(`❌ ${error}`);
}

/**
 * Add warning
 */
function addWarning(warning: string): void {
  rollbackState.warnings.push(warning);
  console.warn(`⚠️ ${warning}`);
}

/**
 * Check if rollback is needed based on criteria
 */
export async function checkRollbackNeeded(
  criteria: RollbackDecisionCriteria = DEFAULT_ROLLBACK_CRITERIA
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
  const reasons: string[] = [];
  const metrics: {
    errorRate?: number;
    avgLatency?: number;
    availability?: number;
    functionalTestPassRate?: number;
  } = {};

  // Check DecisionService health
  try {
    const decisionHealth = await httpGet(`${DECISION_SERVICE_URL}/health`);
    if (!decisionHealth.ok) {
      reasons.push('DecisionService is unhealthy');
    }
  } catch {
    reasons.push('DecisionService is unavailable');
  }

  // Check GenerationService health
  try {
    const generationHealth = await httpGet(`${GENERATION_SERVICE_URL}/health`);
    if (!generationHealth.ok) {
      reasons.push('GenerationService is unhealthy');
    }
  } catch {
    reasons.push('GenerationService is unavailable');
  }

  // Check DecisionService stats for error rate and latency
  try {
    const decisionStats = await httpGet(`${DECISION_SERVICE_URL}/api/stats`);
    if (decisionStats.ok && decisionStats.data?.stats) {
      const stats = decisionStats.data.stats;
      metrics.errorRate = stats.errorRate;
      metrics.avgLatency = stats.averageResponseTime;

      if (stats.errorRate > criteria.errorRateThreshold) {
        reasons.push(`DecisionService error rate (${stats.errorRate}%) exceeds threshold (${criteria.errorRateThreshold}%)`);
      }
      if (stats.averageResponseTime > criteria.latencyThreshold) {
        reasons.push(`DecisionService latency (${stats.averageResponseTime}ms) exceeds threshold (${criteria.latencyThreshold}ms)`);
      }
    }
  } catch {
    addWarning('Could not retrieve DecisionService stats');
  }

  // Check GenerationService stats
  try {
    const generationStats = await httpGet(`${GENERATION_SERVICE_URL}/api/stats`);
    if (generationStats.ok && generationStats.data?.stats) {
      const stats = generationStats.data.stats;
      if (stats.errorRate > criteria.errorRateThreshold) {
        reasons.push(`GenerationService error rate (${stats.errorRate}%) exceeds threshold (${criteria.errorRateThreshold}%)`);
      }
      if (stats.averageResponseTime > criteria.latencyThreshold) {
        reasons.push(`GenerationService latency (${stats.averageResponseTime}ms) exceeds threshold (${criteria.latencyThreshold}ms)`);
      }
    }
  } catch {
    addWarning('Could not retrieve GenerationService stats');
  }

  return {
    needed: reasons.length > 0,
    reasons,
    metrics
  };
}

/**
 * Create backup before rollback
 */
export async function createRollbackBackup(): Promise<{
  success: boolean;
  backupPath?: string;
  error?: string;
}> {
  updateState({ phase: 'backing_up', currentStep: 'Creating rollback backup' });

  try {
    // Ensure backup directory exists
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const timestamp = Date.now();
    const backupPath = path.join(BACKUP_DIR, `rollback-backup-${timestamp}`);
    fs.mkdirSync(backupPath, { recursive: true });

    // Backup configuration from both services
    const configBackup: Record<string, unknown> = {
      timestamp,
      services: {}
    };

    try {
      const decisionConfig = await httpGet(`${DECISION_SERVICE_URL}/api/config`);
      if (decisionConfig.ok) {
        configBackup.services = {
          ...configBackup.services as object,
          'decision-service': decisionConfig.data
        };
      }
    } catch {
      addWarning('Could not backup DecisionService config');
    }

    try {
      const generationConfig = await httpGet(`${GENERATION_SERVICE_URL}/api/config`);
      if (generationConfig.ok) {
        configBackup.services = {
          ...configBackup.services as object,
          'generation-service': generationConfig.data
        };
      }
    } catch {
      addWarning('Could not backup GenerationService config');
    }

    // Save config backup
    fs.writeFileSync(
      path.join(backupPath, 'config-backup.json'),
      JSON.stringify(configBackup, null, 2)
    );

    // Backup model weights if they exist
    const weightsPath = path.join(DATA_DIR, 'models', 'policy-nn-weights.json');
    if (fs.existsSync(weightsPath)) {
      fs.copyFileSync(weightsPath, path.join(backupPath, 'policy-nn-weights.json'));
    }

    // Create rollback manifest
    const manifest = {
      timestamp,
      backupPath,
      services: ['decision-service', 'generation-service'],
      files: fs.readdirSync(backupPath),
      rollbackState: { ...rollbackState }
    };

    fs.writeFileSync(
      path.join(backupPath, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    completeStep('Created rollback backup');
    return { success: true, backupPath };

  } catch (error: any) {
    addError(`Backup creation failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Stop split services
 */
async function stopSplitServices(): Promise<boolean> {
  updateState({ currentStep: 'Stopping split services' });

  let success = true;

  // Try to gracefully stop DecisionService
  try {
    // Send shutdown signal if endpoint exists
    await httpPost(`${DECISION_SERVICE_URL}/api/shutdown`, {}, { timeout: 5000 });
  } catch {
    addWarning('Could not gracefully stop DecisionService');
  }

  // Try to gracefully stop GenerationService
  try {
    await httpPost(`${GENERATION_SERVICE_URL}/api/shutdown`, {}, { timeout: 5000 });
  } catch {
    addWarning('Could not gracefully stop GenerationService');
  }

  // Wait for services to stop
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Verify services are stopped
  try {
    const decisionHealth = await httpGet(`${DECISION_SERVICE_URL}/health`, { timeout: 2000 });
    if (decisionHealth.ok) {
      addWarning('DecisionService is still running');
      success = false;
    }
  } catch {
    // Expected - service should be stopped
  }

  try {
    const generationHealth = await httpGet(`${GENERATION_SERVICE_URL}/health`, { timeout: 2000 });
    if (generationHealth.ok) {
      addWarning('GenerationService is still running');
      success = false;
    }
  } catch {
    // Expected - service should be stopped
  }

  if (success) {
    completeStep('Stopped split services');
  }

  return success;
}

/**
 * Restore configuration from backup
 */
async function restoreConfiguration(backupPath: string): Promise<boolean> {
  updateState({ currentStep: 'Restoring configuration' });

  try {
    const configBackupPath = path.join(backupPath, 'config-backup.json');
    if (!fs.existsSync(configBackupPath)) {
      addWarning('No configuration backup found');
      return true; // Not a critical failure
    }

    const configBackup = JSON.parse(fs.readFileSync(configBackupPath, 'utf-8'));

    // Restore to Web Manager's config backup system
    try {
      await httpPost(`${WEB_MANAGER_URL}/api/config/restore`, {
        backup: configBackup
      }, { timeout: 10000 });
    } catch {
      addWarning('Could not restore configuration through Web Manager');
    }

    completeStep('Restored configuration');
    return true;

  } catch (error: any) {
    addError(`Configuration restore failed: ${error.message}`);
    return false;
  }
}

/**
 * Verify rollback success
 */
async function verifyRollback(): Promise<boolean> {
  updateState({ phase: 'verifying', currentStep: 'Verifying rollback' });

  let success = true;

  // Check Web Manager is still running
  try {
    const webManagerHealth = await httpGet(`${WEB_MANAGER_URL}/health`);
    if (!webManagerHealth.ok) {
      addError('Web Manager is not healthy after rollback');
      success = false;
    }
  } catch {
    addError('Web Manager is unavailable after rollback');
    success = false;
  }

  // Check that split services are stopped
  try {
    await httpGet(`${DECISION_SERVICE_URL}/health`, { timeout: 2000 });
    addWarning('DecisionService is still running after rollback');
  } catch {
    // Expected - service should be stopped
  }

  try {
    await httpGet(`${GENERATION_SERVICE_URL}/health`, { timeout: 2000 });
    addWarning('GenerationService is still running after rollback');
  } catch {
    // Expected - service should be stopped
  }

  if (success) {
    completeStep('Verified rollback');
  }

  return success;
}

/**
 * Execute full rollback procedure
 */
export async function executeRollback(options: {
  force?: boolean;
  backupPath?: string;
} = {}): Promise<{
  success: boolean;
  state: RollbackState;
}> {
  console.log('\n🔄 Starting Migration Rollback Procedure\n');
  console.log('='.repeat(60));

  resetRollbackState();
  updateState({
    phase: 'checking',
    startTime: Date.now(),
    currentStep: 'Checking rollback prerequisites'
  });

  // Step 1: Check if rollback is needed (unless forced)
  if (!options.force) {
    const rollbackCheck = await checkRollbackNeeded();
    if (!rollbackCheck.needed) {
      console.log('\n✅ System is healthy, rollback not needed');
      updateState({ phase: 'completed', endTime: Date.now() });
      return { success: true, state: getRollbackState() };
    }
    console.log('\n⚠️ Rollback needed due to:');
    rollbackCheck.reasons.forEach(r => console.log(`   - ${r}`));
  }

  completeStep('Checked rollback prerequisites');

  // Step 2: Create backup before rollback
  const backupResult = await createRollbackBackup();
  if (!backupResult.success) {
    updateState({ phase: 'failed', endTime: Date.now() });
    return { success: false, state: getRollbackState() };
  }

  const backupPath = options.backupPath || backupResult.backupPath!;

  // Step 3: Stop split services
  updateState({ phase: 'rolling_back' });
  const stopResult = await stopSplitServices();
  if (!stopResult) {
    addWarning('Some services may still be running');
  }

  // Step 4: Restore configuration
  const restoreResult = await restoreConfiguration(backupPath);
  if (!restoreResult) {
    addWarning('Configuration restore had issues');
  }

  // Step 5: Verify rollback
  const verifyResult = await verifyRollback();

  // Complete rollback
  const success = verifyResult && rollbackState.errors.length === 0;
  updateState({
    phase: success ? 'completed' : 'failed',
    endTime: Date.now()
  });

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('Rollback Summary');
  console.log('='.repeat(60));
  console.log(`Status:           ${success ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log(`Duration:         ${(rollbackState.endTime! - rollbackState.startTime!) / 1000}s`);
  console.log(`Completed Steps:  ${rollbackState.completedSteps.length}`);
  console.log(`Warnings:         ${rollbackState.warnings.length}`);
  console.log(`Errors:           ${rollbackState.errors.length}`);

  if (rollbackState.errors.length > 0) {
    console.log('\nErrors:');
    rollbackState.errors.forEach(e => console.log(`  ❌ ${e}`));
  }

  if (rollbackState.warnings.length > 0) {
    console.log('\nWarnings:');
    rollbackState.warnings.forEach(w => console.log(`  ⚠️ ${w}`));
  }

  console.log('='.repeat(60));

  return { success, state: getRollbackState() };
}

/**
 * List available rollback backups
 */
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

  const dirs = fs.readdirSync(BACKUP_DIR)
    .filter(d => d.startsWith('rollback-backup-'))
    .map(d => path.join(BACKUP_DIR, d))
    .filter(p => fs.statSync(p).isDirectory());

  for (const dir of dirs) {
    try {
      const manifestPath = path.join(dir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        backups.push({
          path: dir,
          timestamp: manifest.timestamp,
          date: new Date(manifest.timestamp).toISOString(),
          files: manifest.files || []
        });
      }
    } catch {
      // Skip invalid backups
    }
  }

  return { backups: backups.sort((a, b) => b.timestamp - a.timestamp) };
}

/**
 * Restore from a specific backup
 */
export async function restoreFromBackup(backupPath: string): Promise<{
  success: boolean;
  error?: string;
}> {
  if (!fs.existsSync(backupPath)) {
    return { success: false, error: 'Backup path does not exist' };
  }

  const manifestPath = path.join(backupPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { success: false, error: 'Invalid backup: manifest.json not found' };
  }

  return executeRollback({ backupPath });
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const force = args.includes('--force') || args.includes('-f');
  const listBackups = args.includes('--list') || args.includes('-l');
  const restoreArg = args.find(a => a.startsWith('--restore='));

  if (listBackups) {
    const { backups } = listRollbackBackups();
    console.log('\n📦 Available Rollback Backups:\n');
    if (backups.length === 0) {
      console.log('No backups found.');
    } else {
      backups.forEach((b, i) => {
        console.log(`${i + 1}. ${b.date}`);
        console.log(`   Path: ${b.path}`);
        console.log(`   Files: ${b.files.join(', ')}`);
        console.log('');
      });
    }
    process.exit(0);
  }

  if (restoreArg) {
    const backupPath = restoreArg.split('=')[1];
    restoreFromBackup(backupPath)
      .then(result => {
        process.exit(result.success ? 0 : 1);
      })
      .catch(error => {
        console.error('❌ Restore failed:', error);
        process.exit(1);
      });
  } else {
    executeRollback({ force })
      .then(result => {
        process.exit(result.success ? 0 : 1);
      })
      .catch(error => {
        console.error('❌ Rollback failed:', error);
        process.exit(1);
      });
  }
}
