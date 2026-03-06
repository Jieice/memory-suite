/**
 * Fallback System Deployment Validation
 * 
 * Validates that all fallback handlers are in place and working correctly
 * Generates a deployment report
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const MANAGER_URL = process.env.MANAGER_URL || 'http://localhost:8080';
const MEMORY_UNIVERSE_URL = process.env.MEMORY_UNIVERSE_URL || 'http://localhost:4005';
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
      timestamp: Date.now() - startTime
    });
    console.log(`${passed ? '✅' : '❌'} ${name}`);
  } catch (error: any) {
    results.push({
      name,
      passed: false,
      details: `ERROR: ${error.message}`,
      timestamp: Date.now() - startTime
    });
    console.log(`❌ ${name}: ${error.message}`);
  }
}

async function checkServiceHealth(url: string): Promise<boolean> {
  try {
    const response = await axios.get(`${url}/health`, { timeout: 5000 });
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

async function checkFallbackHandler(serviceName: string, url: string): Promise<boolean> {
  try {
    const response = await axios.get(`${url}/health`, { timeout: 5000 });
    if (response.status !== 200) return false;

    // Check if service has fallback configuration
    const hasTimeout = process.env[`FALLBACK_${serviceName.toUpperCase()}_TIMEOUT`];
    return !!hasTimeout;
  } catch (error) {
    return false;
  }
}

async function checkLogging(): Promise<boolean> {
  try {
    // Check if log directory exists
    const logDir = './logs';
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Check if we can write to logs
    const testFile = path.join(logDir, '.write-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);

    return true;
  } catch (error) {
    return false;
  }
}

async function checkMetrics(): Promise<boolean> {
  try {
    const response = await axios.get(`${MANAGER_URL}/metrics`, { timeout: 5000 });
    return response.status === 200 && response.data.includes('fallback');
  } catch (error) {
    return false;
  }
}

async function checkHealthCheckEndpoint(): Promise<boolean> {
  try {
    const response = await axios.get(`${MANAGER_URL}/api/health-check`, { timeout: 5000 });
    return response.status === 200 && response.data.services;
  } catch (error) {
    return false;
  }
}

async function checkFallbackStatsEndpoint(): Promise<boolean> {
  try {
    const response = await axios.get(`${MANAGER_URL}/api/fallback-stats`, { timeout: 5000 });
    return response.status === 200 && response.data.fallbacksByService;
  } catch (error) {
    return false;
  }
}

async function checkEnvironmentVariables(): Promise<boolean> {
  const requiredVars = [
    'FALLBACK_SYSTEM_ENABLED',
    'FALLBACK_LLM_TIMEOUT',
    'FALLBACK_TTS_TIMEOUT',
    'FALLBACK_BRAINNN_TIMEOUT',
    'FALLBACK_LOG_LEVEL',
    'FALLBACK_METRICS_ENABLED'
  ];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      recommendations.push(`Missing environment variable: ${varName}`);
      return false;
    }
  }

  return true;
}

async function checkConfigurationFiles(): Promise<boolean> {
  const requiredFiles = [
    'docs/FALLBACK_SYSTEM.md',
    'docs/FALLBACK_TROUBLESHOOTING.md',
    'docs/FALLBACK_MONITORING.md'
  ];

  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      recommendations.push(`Missing documentation file: ${file}`);
      return false;
    }
  }

  return true;
}

async function checkEndpointWrapping(): Promise<boolean> {
  try {
    // Test Memory Universe endpoints
    const endpoints = [
      `${MEMORY_UNIVERSE_URL}/api/chat`,
      `${MEMORY_UNIVERSE_URL}/api/chat/creator`,
      `${MEMORY_UNIVERSE_URL}/event`
    ];

    for (const endpoint of endpoints) {
      try {
        await axios.post(endpoint, { message: 'test', userId: 'test' }, { timeout: 5000 });
      } catch (error: any) {
        if (error.response?.status !== 400 && error.response?.status !== 200) {
          return false;
        }
      }
    }

    return true;
  } catch (error) {
    return false;
  }
}

async function checkBrainNNEndpoints(): Promise<boolean> {
  try {
    const endpoints = [
      { method: 'post', url: `${BRAINNN_URL}/think`, data: { text: 'test', source: 'test' } },
      { method: 'get', url: `${BRAINNN_URL}/tick` },
      { method: 'post', url: `${BRAINNN_URL}/feedback`, data: { type: 'positive', value: 0.8 } }
    ];

    for (const endpoint of endpoints) {
      try {
        if (endpoint.method === 'post') {
          await axios.post(endpoint.url, endpoint.data, { timeout: 5000 });
        } else {
          await axios.get(endpoint.url, { timeout: 5000 });
        }
      } catch (error: any) {
        if (error.response?.status !== 400 && error.response?.status !== 200) {
          return false;
        }
      }
    }

    return true;
  } catch (error) {
    return false;
  }
}

async function checkTTSEndpoint(): Promise<boolean> {
  try {
    await axios.post(`${TTS_URL}/api/tts`, { text: 'test' }, { timeout: 5000 });
    return true;
  } catch (error: any) {
    if (error.response?.status === 400 || error.response?.status === 200) {
      return true;
    }
    return false;
  }
}

async function checkTimeoutConfiguration(): Promise<boolean> {
  const timeouts = {
    LLM: parseInt(process.env.FALLBACK_LLM_TIMEOUT || '15000'),
    TTS: parseInt(process.env.FALLBACK_TTS_TIMEOUT || '10000'),
    BRAINNN: parseInt(process.env.FALLBACK_BRAINNN_TIMEOUT || '3000')
  };

  // Validate timeout values
  if (timeouts.LLM < 5000 || timeouts.LLM > 30000) {
    recommendations.push(`LLM timeout ${timeouts.LLM}ms is outside recommended range (5000-30000ms)`);
    return false;
  }

  if (timeouts.TTS < 5000 || timeouts.TTS > 20000) {
    recommendations.push(`TTS timeout ${timeouts.TTS}ms is outside recommended range (5000-20000ms)`);
    return false;
  }

  if (timeouts.BRAINNN < 1000 || timeouts.BRAINNN > 10000) {
    recommendations.push(`BrainNN timeout ${timeouts.BRAINNN}ms is outside recommended range (1000-10000ms)`);
    return false;
  }

  return true;
}

async function checkRetryConfiguration(): Promise<boolean> {
  const maxAttempts = parseInt(process.env.FALLBACK_RETRY_MAX_ATTEMPTS || '2');
  const initialDelay = parseInt(process.env.FALLBACK_RETRY_INITIAL_DELAY || '500');
  const backoffMultiplier = parseInt(process.env.FALLBACK_RETRY_BACKOFF_MULTIPLIER || '2');

  if (maxAttempts < 1 || maxAttempts > 5) {
    recommendations.push(`Max retry attempts ${maxAttempts} is outside recommended range (1-5)`);
    return false;
  }

  if (initialDelay < 100 || initialDelay > 2000) {
    recommendations.push(`Initial retry delay ${initialDelay}ms is outside recommended range (100-2000ms)`);
    return false;
  }

  if (backoffMultiplier < 1 || backoffMultiplier > 5) {
    recommendations.push(`Backoff multiplier ${backoffMultiplier} is outside recommended range (1-5)`);
    return false;
  }

  return true;
}

async function main() {
  console.log('🚀 Starting Fallback System Deployment Validation\n');

  // Phase 1: Service Health
  console.log('📋 Phase 1: Service Health Checks');
  console.log('='.repeat(50));

  const muHealthy = await checkServiceHealth(MEMORY_UNIVERSE_URL);
  const brainnnHealthy = await checkServiceHealth(BRAINNN_URL);
  const ttsHealthy = await checkServiceHealth(TTS_URL);
  const managerHealthy = await checkServiceHealth(MANAGER_URL);

  await validate(
    'Memory Universe Service',
    async () => muHealthy,
    'Memory Universe is healthy'
  );

  await validate(
    'BrainNN Service',
    async () => brainnnHealthy,
    'BrainNN is healthy'
  );

  await validate(
    'TTS Service',
    async () => ttsHealthy,
    'TTS is healthy'
  );

  await validate(
    'Manager Service',
    async () => managerHealthy,
    'Manager is healthy'
  );

  // Phase 2: Fallback Handlers
  console.log('\n📋 Phase 2: Fallback Handler Verification');
  console.log('='.repeat(50));

  await validate(
    'LLM Fallback Handler',
    async () => await checkFallbackHandler('llm', MEMORY_UNIVERSE_URL),
    'LLM fallback handler is configured'
  );

  await validate(
    'TTS Fallback Handler',
    async () => await checkFallbackHandler('tts', TTS_URL),
    'TTS fallback handler is configured'
  );

  await validate(
    'BrainNN Fallback Handler',
    async () => await checkFallbackHandler('brainnn', BRAINNN_URL),
    'BrainNN fallback handler is configured'
  );

  // Phase 3: Logging & Metrics
  console.log('\n📋 Phase 3: Logging & Metrics');
  console.log('='.repeat(50));

  await validate(
    'Logging System',
    async () => await checkLogging(),
    'Logging system is working'
  );

  await validate(
    'Metrics Collection',
    async () => await checkMetrics(),
    'Metrics are being collected'
  );

  await validate(
    'Health Check Endpoint',
    async () => await checkHealthCheckEndpoint(),
    'Health check endpoint is working'
  );

  await validate(
    'Fallback Stats Endpoint',
    async () => await checkFallbackStatsEndpoint(),
    'Fallback stats endpoint is working'
  );

  // Phase 4: Configuration
  console.log('\n📋 Phase 4: Configuration Validation');
  console.log('='.repeat(50));

  await validate(
    'Environment Variables',
    async () => await checkEnvironmentVariables(),
    'All required environment variables are set'
  );

  await validate(
    'Configuration Files',
    async () => await checkConfigurationFiles(),
    'All documentation files are present'
  );

  await validate(
    'Timeout Configuration',
    async () => await checkTimeoutConfiguration(),
    'Timeout values are within recommended ranges'
  );

  await validate(
    'Retry Configuration',
    async () => await checkRetryConfiguration(),
    'Retry configuration is valid'
  );

  // Phase 5: Endpoint Wrapping
  console.log('\n📋 Phase 5: Endpoint Wrapping');
  console.log('='.repeat(50));

  await validate(
    'Memory Universe Endpoints',
    async () => await checkEndpointWrapping(),
    'Memory Universe endpoints are wrapped with fallback'
  );

  await validate(
    'BrainNN Endpoints',
    async () => await checkBrainNNEndpoints(),
    'BrainNN endpoints are wrapped with fallback'
  );

  await validate(
    'TTS Endpoint',
    async () => await checkTTSEndpoint(),
    'TTS endpoint is wrapped with fallback'
  );

  // Generate Report
  console.log('\n📊 Deployment Report');
  console.log('='.repeat(50));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const status = failed === 0 ? 'success' : failed <= 3 ? 'warning' : 'failure';

  const report: DeploymentReport = {
    timestamp: new Date().toISOString(),
    status,
    totalChecks: results.length,
    passedChecks: passed,
    failedChecks: failed,
    results,
    recommendations
  };

  console.log(`Total Checks: ${report.totalChecks}`);
  console.log(`Passed: ${report.passedChecks} ✅`);
  console.log(`Failed: ${report.failedChecks} ❌`);
  console.log(`Status: ${report.status.toUpperCase()}`);

  if (recommendations.length > 0) {
    console.log('\n💡 Recommendations:');
    recommendations.forEach((rec, i) => {
      console.log(`  ${i + 1}. ${rec}`);
    });
  }

  // Save Report
  const reportPath = './fallback-deployment-report.json';
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 Report saved to: ${reportPath}`);

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

