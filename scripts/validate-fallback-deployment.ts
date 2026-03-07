import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const RUNTIME_URL = process.env.MEMORY_SUITE_URL || process.env.MANAGER_URL || 'http://localhost:8080';
const BRAINNN_URL = process.env.BRAINNN_URL || 'http://localhost:4007';
const TTS_URL = process.env.TTS_SERVICE_URL || 'http://localhost:4014';

interface ValidationResult {
  name: string;
  passed: boolean;
  details: string;
  timestamp: number;
}

interface DeploymentReport {
  timestamp: string;
  status: 'success' | 'warning' | 'failure';
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  results: ValidationResult[];
  recommendations: string[];
}

const results: ValidationResult[] = [];
const recommendations: string[] = [];

async function validate(name: string, testFn: () => Promise<boolean>, details: string): Promise<void> {
  const startTime = Date.now();
  try {
    const passed = await testFn();
    results.push({
      name,
      passed,
      details: passed ? details : `FAILED: ${details}`,
      timestamp: Date.now() - startTime,
    });
    console.log(`${passed ? 'OK' : 'FAIL'} ${name}`);
  } catch (error: any) {
    results.push({
      name,
      passed: false,
      details: `ERROR: ${error.message}`,
      timestamp: Date.now() - startTime,
    });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

async function checkUrl(url: string): Promise<boolean> {
  try {
    const response = await axios.get(url, { timeout: 5000 });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function checkLogging(): Promise<boolean> {
  const logDir = './logs';
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const testFile = path.join(logDir, '.write-test');
  fs.writeFileSync(testFile, 'test');
  fs.unlinkSync(testFile);
  return true;
}

async function generateReport(): Promise<void> {
  const passedChecks = results.filter((result) => result.passed).length;
  const failedChecks = results.length - passedChecks;

  if (failedChecks > 0) {
    recommendations.push('Start the unified runtime with start-unified.bat before deployment.');
  }
  if (!(await checkUrl(`${BRAINNN_URL}/health`))) {
    recommendations.push('BrainNN is optional; verify only if your pipeline still depends on it.');
  }
  if (!(await checkUrl(`${TTS_URL}/health`))) {
    recommendations.push('TTS sidecar is optional; verify only if your selected adapter requires it.');
  }

  const report: DeploymentReport = {
    timestamp: new Date().toISOString(),
    status: failedChecks === 0 ? 'success' : passedChecks > 0 ? 'warning' : 'failure',
    totalChecks: results.length,
    passedChecks,
    failedChecks,
    results,
    recommendations,
  };

  const reportPath = path.join('reports', `unified-runtime-validation-${Date.now()}.json`);
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\nReport written to ${reportPath}`);
}

async function main(): Promise<void> {
  console.log('Validating unified runtime deployment...\n');

  await validate('Unified health', () => checkUrl(`${RUNTIME_URL}/api/health`), 'Unified health endpoint responds');
  await validate(
    'Runtime overview',
    () => checkUrl(`${RUNTIME_URL}/api/runtime/overview`),
    'Runtime overview endpoint responds',
  );
  await validate('Live2D state', () => checkUrl(`${RUNTIME_URL}/api/live2d/state`), 'Live2D state endpoint responds');
  await validate('Danmaku state', () => checkUrl(`${RUNTIME_URL}/api/danmaku/state`), 'Danmaku state endpoint responds');
  await validate('Logging writable', checkLogging, 'Log directory is writable');

  await generateReport();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
