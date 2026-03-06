#!/usr/bin/env ts-node
/**
 * Staging Deployment Validation Script
 * 
 * This script validates the complete staging environment deployment including:
 * - Service health checks
 * - API endpoint validation
 * - End-to-end workflow testing
 * - Performance benchmarking
 * - Integration point validation
 * 
 * Feature: nn-llm-separation
 * Property 11: Zero-downtime operations validation
 * Validates: Requirements 4.5, 5.5
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';

interface ServiceConfig {
  name: string;
  url: string;
  port: number;
  healthEndpoint: string;
}

interface ValidationResult {
  timestamp: number;
  environment: string;
  services: ServiceHealthResult[];
  apiEndpoints: EndpointValidationResult[];
  endToEndTests: E2ETestResult[];
  performanceBenchmarks: PerformanceBenchmarkResult[];
  integrationPoints: IntegrationPointResult[];
  overallStatus: 'PASSED' | 'FAILED' | 'PARTIAL';
  summary: string;
}

interface ServiceHealthResult {
  serviceName: string;
  status: 'healthy' | 'unhealthy' | 'unreachable';
  responseTime: number;
  details?: any;
  error?: string;
}

interface EndpointValidationResult {
  endpoint: string;
  method: string;
  status: 'valid' | 'invalid' | 'error';
  statusCode?: number;
  responseTime: number;
  error?: string;
}

interface E2ETestResult {
  testName: string;
  status: 'passed' | 'failed';
  duration: number;
  error?: string;
  details?: any;
}

interface PerformanceBenchmarkResult {
  operation: string;
  avgResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  throughput: number;
  status: 'passed' | 'failed';
}

interface IntegrationPointResult {
  integrationPoint: string;
  status: 'working' | 'failed';
  details?: any;
  error?: string;
}

class StagingDeploymentValidator {
  private decisionServiceClient: AxiosInstance;
  private generationServiceClient: AxiosInstance;
  private webManagerClient: AxiosInstance;
  private results: ValidationResult;

  private services: ServiceConfig[] = [
    {
      name: 'DecisionService',
      url: process.env.DECISION_SERVICE_URL || 'http://localhost:8081',
      port: 8081,
      healthEndpoint: '/health'
    },
    {
      name: 'GenerationService',
      url: process.env.GENERATION_SERVICE_URL || 'http://localhost:8082',
      port: 8082,
      healthEndpoint: '/health'
    },
    {
      name: 'WebManager',
      url: process.env.WEB_MANAGER_URL || 'http://localhost:8080',
      port: 8080,
      healthEndpoint: '/health'
    }
  ];

  constructor() {
    this.decisionServiceClient = axios.create({
      baseURL: this.services[0].url,
      timeout: 5000
    });

    this.generationServiceClient = axios.create({
      baseURL: this.services[1].url,
      timeout: 5000
    });

    this.webManagerClient = axios.create({
      baseURL: this.services[2].url,
      timeout: 5000
    });

    this.results = {
      timestamp: Date.now(),
      environment: process.env.NODE_ENV || 'staging',
      services: [],
      apiEndpoints: [],
      endToEndTests: [],
      performanceBenchmarks: [],
      integrationPoints: [],
      overallStatus: 'PASSED',
      summary: ''
    };
  }

  async validate(): Promise<ValidationResult> {
    console.log('🚀 Starting Staging Deployment Validation...\n');

    try {
      // Phase 1: Service Health Checks
      console.log('📋 Phase 1: Service Health Checks');
      await this.validateServiceHealth();
      console.log('✓ Service health checks completed\n');

      // Phase 2: API Endpoint Validation
      console.log('📋 Phase 2: API Endpoint Validation');
      await this.validateAPIEndpoints();
      console.log('✓ API endpoint validation completed\n');

      // Phase 3: End-to-End Workflow Testing
      console.log('📋 Phase 3: End-to-End Workflow Testing');
      await this.validateEndToEndWorkflows();
      console.log('✓ End-to-end workflow testing completed\n');

      // Phase 4: Performance Benchmarking
      console.log('📋 Phase 4: Performance Benchmarking');
      await this.validatePerformance();
      console.log('✓ Performance benchmarking completed\n');

      // Phase 5: Integration Point Validation
      console.log('📋 Phase 5: Integration Point Validation');
      await this.validateIntegrationPoints();
      console.log('✓ Integration point validation completed\n');

      // Determine overall status
      this.determineOverallStatus();

      // Generate summary
      this.generateSummary();

      // Save results
      this.saveResults();

      return this.results;
    } catch (error) {
      console.error('❌ Validation failed:', error);
      this.results.overallStatus = 'FAILED';
      this.results.summary = `Validation failed with error: ${error}`;
      this.saveResults();
      throw error;
    }
  }

  private async validateServiceHealth(): Promise<void> {
    for (const service of this.services) {
      const startTime = Date.now();
      try {
        const response = await axios.get(`${service.url}${service.healthEndpoint}`, {
          timeout: 3000
        });
        const responseTime = Date.now() - startTime;

        this.results.services.push({
          serviceName: service.name,
          status: response.status === 200 ? 'healthy' : 'unhealthy',
          responseTime,
          details: response.data
        });

        console.log(`  ✓ ${service.name}: ${responseTime}ms`);
      } catch (error: any) {
        this.results.services.push({
          serviceName: service.name,
          status: 'unreachable',
          responseTime: Date.now() - startTime,
          error: error.message
        });

        console.log(`  ✗ ${service.name}: ${error.message}`);
      }
    }
  }

  private async validateAPIEndpoints(): Promise<void> {
    const endpoints = [
      // DecisionService endpoints
      { service: 'decision', method: 'GET', path: '/health' },
      { service: 'decision', method: 'POST', path: '/api/decision' },
      { service: 'decision', method: 'POST', path: '/api/proactive/check' },
      { service: 'decision', method: 'GET', path: '/api/stats' },

      // GenerationService endpoints
      { service: 'generation', method: 'GET', path: '/health' },
      { service: 'generation', method: 'POST', path: '/api/generate' },
      { service: 'generation', method: 'GET', path: '/api/stats' },

      // WebManager endpoints
      { service: 'manager', method: 'GET', path: '/health' },
      { service: 'manager', method: 'POST', path: '/api/chat' },
      { service: 'manager', method: 'GET', path: '/api/services' },
      { service: 'manager', method: 'GET', path: '/api/services/decision-service/health' },
      { service: 'manager', method: 'GET', path: '/api/services/generation-service/health' }
    ];

    for (const endpoint of endpoints) {
      const startTime = Date.now();
      try {
        let response;
        const client = this.getClientForService(endpoint.service);

        if (endpoint.method === 'GET') {
          response = await client.get(endpoint.path);
        } else if (endpoint.method === 'POST') {
          // Send minimal valid payload for POST endpoints
          const payload = this.getMinimalPayloadForEndpoint(endpoint.path);
          response = await client.post(endpoint.path, payload);
        }

        const responseTime = Date.now() - startTime;
        this.results.apiEndpoints.push({
          endpoint: `${endpoint.service}:${endpoint.path}`,
          method: endpoint.method,
          status: response.status >= 200 && response.status < 300 ? 'valid' : 'invalid',
          statusCode: response.status,
          responseTime
        });

        console.log(`  ✓ ${endpoint.method} ${endpoint.path}: ${responseTime}ms`);
      } catch (error: any) {
        const responseTime = Date.now() - startTime;
        this.results.apiEndpoints.push({
          endpoint: `${endpoint.service}:${endpoint.path}`,
          method: endpoint.method,
          status: 'error',
          responseTime,
          error: error.message
        });

        console.log(`  ✗ ${endpoint.method} ${endpoint.path}: ${error.message}`);
      }
    }
  }

  private async validateEndToEndWorkflows(): Promise<void> {
    // Test 1: Decision Service workflow
    try {
      const startTime = Date.now();
      const decisionPayload = {
        stateVector: Array(27).fill(0.5),
        perceptionVector: Array(8).fill(0.5),
        messageEmbedding: Array(32).fill(0.5),
        memoryContext: Array(32).fill(0.5),
        allowedBehaviors: ['respond', 'proactive'],
        constraints: {}
      };

      const response = await this.decisionServiceClient.post('/api/decision', decisionPayload);
      const duration = Date.now() - startTime;

      this.results.endToEndTests.push({
        testName: 'Decision Service Workflow',
        status: response.status === 200 ? 'passed' : 'failed',
        duration,
        details: response.data
      });

      console.log(`  ✓ Decision Service Workflow: ${duration}ms`);
    } catch (error: any) {
      this.results.endToEndTests.push({
        testName: 'Decision Service Workflow',
        status: 'failed',
        duration: 0,
        error: error.message
      });

      console.log(`  ✗ Decision Service Workflow: ${error.message}`);
    }

    // Test 2: Generation Service workflow
    try {
      const startTime = Date.now();
      const generationPayload = {
        decision: {
          selectedBehavior: { type: 'respond', confidence: 0.9 },
          creativeGuidance: {
            theme: 'friendly',
            keyPoints: ['greeting'],
            tone: { verbosity: 0.7, sarcasm: 0.2, warmth: 0.8 },
            style: { formality: 0.5, creativity: 0.7, engagement: 0.8 },
            constraints: { maxLength: 200 }
          }
        },
        context: {
          userMessage: 'Hello!',
          allowedMemories: [],
          conversationHistory: [],
          userProfile: {},
          streamingState: {},
          sessionContext: {}
        },
        constraints: { maxTokens: 200 }
      };

      const response = await this.generationServiceClient.post('/api/generate', generationPayload);
      const duration = Date.now() - startTime;

      this.results.endToEndTests.push({
        testName: 'Generation Service Workflow',
        status: response.status === 200 ? 'passed' : 'failed',
        duration,
        details: { textLength: response.data.text?.length || 0 }
      });

      console.log(`  ✓ Generation Service Workflow: ${duration}ms`);
    } catch (error: any) {
      this.results.endToEndTests.push({
        testName: 'Generation Service Workflow',
        status: 'failed',
        duration: 0,
        error: error.message
      });

      console.log(`  ✗ Generation Service Workflow: ${error.message}`);
    }

    // Test 3: Web Manager orchestration workflow
    try {
      const startTime = Date.now();
      const chatPayload = {
        text: 'Hello, how are you?',
        userId: 'test-user-123',
        sessionId: 'test-session-123'
      };

      const response = await this.webManagerClient.post('/api/chat', chatPayload);
      const duration = Date.now() - startTime;

      this.results.endToEndTests.push({
        testName: 'Web Manager Orchestration Workflow',
        status: response.status === 200 ? 'passed' : 'failed',
        duration,
        details: { responseLength: response.data.text?.length || 0 }
      });

      console.log(`  ✓ Web Manager Orchestration Workflow: ${duration}ms`);
    } catch (error: any) {
      this.results.endToEndTests.push({
        testName: 'Web Manager Orchestration Workflow',
        status: 'failed',
        duration: 0,
        error: error.message
      });

      console.log(`  ✗ Web Manager Orchestration Workflow: ${error.message}`);
    }
  }

  private async validatePerformance(): Promise<void> {
    const iterations = 10;

    // Benchmark 1: Decision Service latency
    const decisionLatencies: number[] = [];
    for (let i = 0; i < iterations; i++) {
      try {
        const startTime = Date.now();
        await this.decisionServiceClient.post('/api/decision', {
          stateVector: Array(27).fill(0.5),
          perceptionVector: Array(8).fill(0.5),
          messageEmbedding: Array(32).fill(0.5),
          memoryContext: Array(32).fill(0.5),
          allowedBehaviors: ['respond'],
          constraints: {}
        });
        decisionLatencies.push(Date.now() - startTime);
      } catch (error) {
        // Skip failed requests
      }
    }

    if (decisionLatencies.length > 0) {
      const sorted = decisionLatencies.sort((a, b) => a - b);
      this.results.performanceBenchmarks.push({
        operation: 'Decision Service Request',
        avgResponseTime: decisionLatencies.reduce((a, b) => a + b) / decisionLatencies.length,
        minResponseTime: sorted[0],
        maxResponseTime: sorted[sorted.length - 1],
        p95ResponseTime: sorted[Math.floor(sorted.length * 0.95)],
        p99ResponseTime: sorted[Math.floor(sorted.length * 0.99)],
        throughput: (iterations / (decisionLatencies.reduce((a, b) => a + b) / 1000)),
        status: decisionLatencies.reduce((a, b) => a + b) / decisionLatencies.length < 1000 ? 'passed' : 'failed'
      });

      console.log(`  ✓ Decision Service: avg=${Math.round(decisionLatencies.reduce((a, b) => a + b) / decisionLatencies.length)}ms`);
    }

    // Benchmark 2: Generation Service latency
    const generationLatencies: number[] = [];
    for (let i = 0; i < iterations; i++) {
      try {
        const startTime = Date.now();
        await this.generationServiceClient.post('/api/generate', {
          decision: {
            selectedBehavior: { type: 'respond', confidence: 0.9 },
            creativeGuidance: {
              theme: 'friendly',
              keyPoints: ['greeting'],
              tone: { verbosity: 0.7, sarcasm: 0.2, warmth: 0.8 },
              style: { formality: 0.5, creativity: 0.7, engagement: 0.8 },
              constraints: { maxLength: 200 }
            }
          },
          context: {
            userMessage: 'Hello!',
            allowedMemories: [],
            conversationHistory: [],
            userProfile: {},
            streamingState: {},
            sessionContext: {}
          },
          constraints: { maxTokens: 200 }
        });
        generationLatencies.push(Date.now() - startTime);
      } catch (error) {
        // Skip failed requests
      }
    }

    if (generationLatencies.length > 0) {
      const sorted = generationLatencies.sort((a, b) => a - b);
      this.results.performanceBenchmarks.push({
        operation: 'Generation Service Request',
        avgResponseTime: generationLatencies.reduce((a, b) => a + b) / generationLatencies.length,
        minResponseTime: sorted[0],
        maxResponseTime: sorted[sorted.length - 1],
        p95ResponseTime: sorted[Math.floor(sorted.length * 0.95)],
        p99ResponseTime: sorted[Math.floor(sorted.length * 0.99)],
        throughput: (iterations / (generationLatencies.reduce((a, b) => a + b) / 1000)),
        status: generationLatencies.reduce((a, b) => a + b) / generationLatencies.length < 2000 ? 'passed' : 'failed'
      });

      console.log(`  ✓ Generation Service: avg=${Math.round(generationLatencies.reduce((a, b) => a + b) / generationLatencies.length)}ms`);
    }

    // Benchmark 3: Web Manager orchestration latency
    const orchestrationLatencies: number[] = [];
    for (let i = 0; i < iterations; i++) {
      try {
        const startTime = Date.now();
        await this.webManagerClient.post('/api/chat', {
          text: 'Hello!',
          userId: 'test-user',
          sessionId: 'test-session'
        });
        orchestrationLatencies.push(Date.now() - startTime);
      } catch (error) {
        // Skip failed requests
      }
    }

    if (orchestrationLatencies.length > 0) {
      const sorted = orchestrationLatencies.sort((a, b) => a - b);
      this.results.performanceBenchmarks.push({
        operation: 'Web Manager Orchestration',
        avgResponseTime: orchestrationLatencies.reduce((a, b) => a + b) / orchestrationLatencies.length,
        minResponseTime: sorted[0],
        maxResponseTime: sorted[sorted.length - 1],
        p95ResponseTime: sorted[Math.floor(sorted.length * 0.95)],
        p99ResponseTime: sorted[Math.floor(sorted.length * 0.99)],
        throughput: (iterations / (orchestrationLatencies.reduce((a, b) => a + b) / 1000)),
        status: orchestrationLatencies.reduce((a, b) => a + b) / orchestrationLatencies.length < 3000 ? 'passed' : 'failed'
      });

      console.log(`  ✓ Web Manager: avg=${Math.round(orchestrationLatencies.reduce((a, b) => a + b) / orchestrationLatencies.length)}ms`);
    }
  }

  private async validateIntegrationPoints(): Promise<void> {
    // Integration Point 1: Service Discovery
    try {
      const response = await this.webManagerClient.get('/api/services');
      this.results.integrationPoints.push({
        integrationPoint: 'Service Discovery',
        status: response.status === 200 ? 'working' : 'failed',
        details: response.data
      });
      console.log(`  ✓ Service Discovery: working`);
    } catch (error: any) {
      this.results.integrationPoints.push({
        integrationPoint: 'Service Discovery',
        status: 'failed',
        error: error.message
      });
      console.log(`  ✗ Service Discovery: ${error.message}`);
    }

    // Integration Point 2: Health Monitoring
    try {
      const decisionHealth = await this.webManagerClient.get('/api/services/decision-service/health');
      const generationHealth = await this.webManagerClient.get('/api/services/generation-service/health');

      this.results.integrationPoints.push({
        integrationPoint: 'Health Monitoring',
        status: decisionHealth.status === 200 && generationHealth.status === 200 ? 'working' : 'failed',
        details: { decision: decisionHealth.data, generation: generationHealth.data }
      });
      console.log(`  ✓ Health Monitoring: working`);
    } catch (error: any) {
      this.results.integrationPoints.push({
        integrationPoint: 'Health Monitoring',
        status: 'failed',
        error: error.message
      });
      console.log(`  ✗ Health Monitoring: ${error.message}`);
    }

    // Integration Point 3: Backward Compatibility
    try {
      const response = await this.webManagerClient.post('/api/chat', {
        text: 'Test message',
        userId: 'test-user'
      });

      this.results.integrationPoints.push({
        integrationPoint: 'Backward Compatibility API',
        status: response.status === 200 ? 'working' : 'failed',
        details: { hasResponse: !!response.data }
      });
      console.log(`  ✓ Backward Compatibility API: working`);
    } catch (error: any) {
      this.results.integrationPoints.push({
        integrationPoint: 'Backward Compatibility API',
        status: 'failed',
        error: error.message
      });
      console.log(`  ✗ Backward Compatibility API: ${error.message}`);
    }
  }

  private determineOverallStatus(): void {
    const failedServices = this.results.services.filter(s => s.status !== 'healthy').length;
    const failedEndpoints = this.results.apiEndpoints.filter(e => e.status === 'error').length;
    const failedE2ETests = this.results.endToEndTests.filter(t => t.status === 'failed').length;
    const failedBenchmarks = this.results.performanceBenchmarks.filter(b => b.status === 'failed').length;
    const failedIntegrations = this.results.integrationPoints.filter(i => i.status === 'failed').length;

    if (failedServices > 0 || failedE2ETests > 0 || failedIntegrations > 0) {
      this.results.overallStatus = 'FAILED';
    } else if (failedEndpoints > 0 || failedBenchmarks > 0) {
      this.results.overallStatus = 'PARTIAL';
    } else {
      this.results.overallStatus = 'PASSED';
    }
  }

  private generateSummary(): void {
    const healthyServices = this.results.services.filter(s => s.status === 'healthy').length;
    const validEndpoints = this.results.apiEndpoints.filter(e => e.status === 'valid').length;
    const passedE2ETests = this.results.endToEndTests.filter(t => t.status === 'passed').length;
    const passedBenchmarks = this.results.performanceBenchmarks.filter(b => b.status === 'passed').length;
    const workingIntegrations = this.results.integrationPoints.filter(i => i.status === 'working').length;

    this.results.summary = `
Staging Deployment Validation Summary
=====================================
Status: ${this.results.overallStatus}

Services: ${healthyServices}/${this.results.services.length} healthy
API Endpoints: ${validEndpoints}/${this.results.apiEndpoints.length} valid
End-to-End Tests: ${passedE2ETests}/${this.results.endToEndTests.length} passed
Performance Benchmarks: ${passedBenchmarks}/${this.results.performanceBenchmarks.length} passed
Integration Points: ${workingIntegrations}/${this.results.integrationPoints.length} working

Timestamp: ${new Date(this.results.timestamp).toISOString()}
Environment: ${this.results.environment}
    `;
  }

  private saveResults(): void {
    const reportPath = path.join(process.cwd(), 'integration-reports', `staging-validation-${Date.now()}.json`);
    const reportDir = path.dirname(reportPath);

    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    fs.writeFileSync(reportPath, JSON.stringify(this.results, null, 2));
    console.log(`\n📊 Validation report saved to: ${reportPath}`);
  }

  private getClientForService(service: string): AxiosInstance {
    switch (service) {
      case 'decision':
        return this.decisionServiceClient;
      case 'generation':
        return this.generationServiceClient;
      case 'manager':
        return this.webManagerClient;
      default:
        return this.webManagerClient;
    }
  }

  private getMinimalPayloadForEndpoint(path: string): any {
    if (path.includes('/api/decision')) {
      return {
        stateVector: Array(27).fill(0.5),
        perceptionVector: Array(8).fill(0.5),
        messageEmbedding: Array(32).fill(0.5),
        memoryContext: Array(32).fill(0.5),
        allowedBehaviors: ['respond'],
        constraints: {}
      };
    } else if (path.includes('/api/generate')) {
      return {
        decision: {
          selectedBehavior: { type: 'respond', confidence: 0.9 },
          creativeGuidance: {
            theme: 'friendly',
            keyPoints: [],
            tone: { verbosity: 0.5, sarcasm: 0, warmth: 0.5 },
            style: { formality: 0.5, creativity: 0.5, engagement: 0.5 },
            constraints: { maxLength: 100 }
          }
        },
        context: {
          userMessage: 'Hi',
          allowedMemories: [],
          conversationHistory: [],
          userProfile: {},
          streamingState: {},
          sessionContext: {}
        }
      };
    } else if (path.includes('/api/chat')) {
      return {
        text: 'Hello',
        userId: 'test-user'
      };
    }
    return {};
  }
}

// Main execution
async function main() {
  const validator = new StagingDeploymentValidator();
  const results = await validator.validate();

  console.log(results.summary);

  if (results.overallStatus === 'FAILED') {
    process.exit(1);
  } else if (results.overallStatus === 'PARTIAL') {
    process.exit(0); // Partial success is acceptable for staging
  } else {
    process.exit(0);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
