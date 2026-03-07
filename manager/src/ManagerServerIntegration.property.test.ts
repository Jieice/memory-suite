/**
 * ManagerServerIntegration Property Tests
 * 
 * Property 6: Comprehensive monitoring and configuration
 * Validates: Requirements 2.3, 2.4, 7.1, 7.4, 9.1, 9.2
 * 
 * Tests that the ManagerServerIntegration correctly:
 * - Performs multi-service health checks
 * - Coordinates training between services
 * - Collects and aggregates statistics
 * - Manages service configuration
 */

import * as fc from 'fast-check';
import {
  ManagerServerIntegration,
  ServiceHealthStatus,
  MultiServiceHealthResult,
  ServiceEndpointConfig,
  TrainingStatus,
  TrainingCoordinationResult,
  ServiceStats,
  AggregatedStats,
  ManagerIntegrationConfig
} from './ManagerServerIntegration';

// Test configuration
const TEST_ITERATIONS = 100;

describe('Feature: nn-llm-separation, Property 6: Comprehensive monitoring and configuration', () => {
  let integration: ManagerServerIntegration;

  beforeEach(() => {
    integration = new ManagerServerIntegration({
      decisionService: {
        name: 'DecisionService',
        url: 'http://localhost:8080',
        healthEndpoint: '/health',
        statsEndpoint: '/api/stats',
        timeout: 5000
      },
      generationService: {
        name: 'GenerationService',
        url: 'http://localhost:4007',
        healthEndpoint: '/health',
        statsEndpoint: '/api/stats',
        timeout: 5000
      },
      ttsService: {
        name: 'TTS Service',
        url: 'http://localhost:4014',
        healthEndpoint: '/health',
        timeout: 3000
      },
      live2dService: {
        name: 'Live2D Service',
        url: 'http://localhost:8080',
        healthEndpoint: '/api/live2d/state',
        timeout: 3000
      },
      danmakuService: {
        name: 'Danmaku Service',
        url: 'http://localhost:8080',
        healthEndpoint: '/api/danmaku/state',
        timeout: 3000
      },
      healthCheckTimeout: 60000,
      statsCollectionInterval: 60000
    });
  });

  afterEach(() => {
    integration.stop();
  });

  it('should default live2d and danmaku monitoring to the unified daemon surface', () => {
    const defaults = new ManagerServerIntegration();

    expect(defaults.getServiceConfig('live2d')).toMatchObject({
      url: 'http://localhost:8080',
      healthEndpoint: '/api/live2d/state',
    });
    expect(defaults.getServiceConfig('danmaku')).toMatchObject({
      url: 'http://localhost:8080',
      healthEndpoint: '/api/danmaku/state',
    });
  });

  /**
   * Property 6.1: Health check structure validation
   * For any service configuration, health checks should return
   * properly structured ServiceHealthStatus objects.
   * Validates: Requirements 2.3, 7.1
   */
  describe('Property 6.1: Health check structure validation', () => {
    // Generator for service endpoint configurations
    const serviceConfigArb = fc.record({
      name: fc.string({ minLength: 1, maxLength: 50 }),
      url: fc.constantFrom(
        'http://localhost:8080',
        'http://localhost:4014',
        'http://localhost:8080',
        'http://localhost:4007'
      ),
      healthEndpoint: fc.constantFrom('/health', '/api/live2d/state', '/api/danmaku/state', '/api/health'),
      timeout: fc.integer({ min: 1000, max: 30000 })
    });

    it('should produce valid ServiceHealthStatus structure for any config', async () => {
      await fc.assert(
        fc.asyncProperty(
          serviceConfigArb,
          async (config) => {
            const healthStatus = await integration.checkServiceHealth(config);

            // Validate structure
            expect(healthStatus).toHaveProperty('name');
            expect(healthStatus).toHaveProperty('status');
            expect(healthStatus).toHaveProperty('responseTime');
            expect(healthStatus).toHaveProperty('lastCheck');

            // Validate types
            expect(typeof healthStatus.name).toBe('string');
            expect(['healthy', 'degraded', 'unhealthy', 'unknown']).toContain(healthStatus.status);
            expect(typeof healthStatus.responseTime).toBe('number');
            expect(healthStatus.lastCheck).toBeInstanceOf(Date);

            // Response time should be non-negative
            expect(healthStatus.responseTime).toBeGreaterThanOrEqual(0);

            return true;
          }
        ),
        { numRuns: 20 } // Reduced iterations due to network calls
      );
    });

    it('should return valid MultiServiceHealthResult structure', async () => {
      const result = await integration.performHealthCheck();

      // Validate top-level structure
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('overallStatus');
      expect(result).toHaveProperty('services');
      expect(result).toHaveProperty('summary');

      // Validate timestamp
      expect(result.timestamp).toBeInstanceOf(Date);

      // Validate overall status
      expect(['healthy', 'degraded', 'unhealthy']).toContain(result.overallStatus);

      // Validate services object has all required services
      expect(result.services).toHaveProperty('decisionService');
      expect(result.services).toHaveProperty('generationService');
      expect(result.services).toHaveProperty('ttsService');
      expect(result.services).toHaveProperty('live2dService');
      expect(result.services).toHaveProperty('danmakuService');

      // Validate summary
      expect(typeof result.summary.healthy).toBe('number');
      expect(typeof result.summary.degraded).toBe('number');
      expect(typeof result.summary.unhealthy).toBe('number');
      expect(typeof result.summary.total).toBe('number');

      // Summary counts should be consistent
      expect(result.summary.healthy + result.summary.degraded + result.summary.unhealthy)
        .toBeLessThanOrEqual(result.summary.total);
    });
  });

  /**
   * Property 6.2: Health status aggregation consistency
   * The aggregated health status should be consistent with individual service statuses.
   * Validates: Requirements 2.3, 7.1
   */
  describe('Property 6.2: Health status aggregation consistency', () => {
    it('should have consistent health status aggregation', () => {
      const healthStatus = integration.getHealthStatus();

      // Validate structure
      expect(healthStatus).toHaveProperty('success');
      expect(healthStatus).toHaveProperty('healthy');
      expect(healthStatus).toHaveProperty('total');
      expect(healthStatus).toHaveProperty('overallStatus');
      expect(healthStatus).toHaveProperty('results');

      // Validate types
      expect(typeof healthStatus.success).toBe('boolean');
      expect(typeof healthStatus.healthy).toBe('number');
      expect(typeof healthStatus.total).toBe('number');
      expect(typeof healthStatus.overallStatus).toBe('string');

      // Healthy count should not exceed total
      expect(healthStatus.healthy).toBeLessThanOrEqual(healthStatus.total);
      expect(healthStatus.healthy).toBeGreaterThanOrEqual(0);
    });
  });

  /**
   * Property 6.3: Training status structure validation
   * Training status should always return a properly structured object.
   * Validates: Requirements 2.4
   */
  describe('Property 6.3: Training status structure validation', () => {
    it('should return valid TrainingStatus structure', async () => {
      const status = await integration.getTrainingStatus();

      // Validate structure
      expect(status).toHaveProperty('available');
      expect(status).toHaveProperty('inProgress');
      expect(status).toHaveProperty('config');
      expect(status).toHaveProperty('totalSamples');
      expect(status).toHaveProperty('hasBackup');
      expect(status).toHaveProperty('message');

      // Validate types
      expect(typeof status.available).toBe('boolean');
      expect(typeof status.inProgress).toBe('boolean');
      expect(typeof status.totalSamples).toBe('number');
      expect(typeof status.hasBackup).toBe('boolean');
      expect(typeof status.message).toBe('string');

      // Validate config structure
      expect(status.config).toHaveProperty('minSamples');
      expect(status.config).toHaveProperty('maxSamples');
      expect(status.config).toHaveProperty('learningRate');
      expect(status.config).toHaveProperty('batchSize');
      expect(status.config).toHaveProperty('epochs');

      // Validate config values are reasonable
      expect(status.config.minSamples).toBeGreaterThanOrEqual(0);
      expect(status.config.maxSamples).toBeGreaterThan(status.config.minSamples);
      expect(status.config.learningRate).toBeGreaterThan(0);
      expect(status.config.batchSize).toBeGreaterThan(0);
      expect(status.config.epochs).toBeGreaterThan(0);
    });
  });

  /**
   * Property 6.4: Training coordination result structure
   * Training coordination should return properly structured results.
   * Validates: Requirements 2.4
   */
  describe('Property 6.4: Training coordination result structure', () => {
    // Generator for training options
    const trainingOptionsArb = fc.record({
      sessionId: fc.option(fc.uuid()),
      epochs: fc.option(fc.integer({ min: 1, max: 100 })),
      learningRate: fc.option(fc.float({ min: Math.fround(0.00001), max: Math.fround(0.1), noNaN: true }))
    });

    it('should return valid TrainingCoordinationResult structure', async () => {
      await fc.assert(
        fc.asyncProperty(
          trainingOptionsArb,
          async (options) => {
            const result = await integration.coordinateTraining({
              sessionId: options.sessionId ?? undefined,
              epochs: options.epochs ?? undefined,
              learningRate: options.learningRate ?? undefined
            });

            // Validate structure
            expect(result).toHaveProperty('success');
            expect(result).toHaveProperty('message');
            expect(result).toHaveProperty('trainingStarted');

            // Validate types
            expect(typeof result.success).toBe('boolean');
            expect(typeof result.message).toBe('string');
            expect(typeof result.trainingStarted).toBe('boolean');

            // If failed, should have error
            if (!result.success) {
              expect(result.error || result.message).toBeTruthy();
            }

            return true;
          }
        ),
        { numRuns: 10 } // Reduced iterations due to network calls
      );
    });
  });

  /**
   * Property 6.5: Statistics collection structure validation
   * Statistics collection should return properly structured objects.
   * Validates: Requirements 2.3, 7.4
   */
  describe('Property 6.5: Statistics collection structure validation', () => {
    it('should return valid AggregatedStats structure', async () => {
      const stats = await integration.collectStats();

      // Validate top-level structure
      expect(stats).toHaveProperty('timestamp');
      expect(stats).toHaveProperty('services');
      expect(stats).toHaveProperty('aggregated');

      // Validate timestamp
      expect(stats.timestamp).toBeInstanceOf(Date);

      // Validate services object
      expect(stats.services).toHaveProperty('decisionService');
      expect(stats.services).toHaveProperty('generationService');

      // Validate aggregated structure
      expect(stats.aggregated).toHaveProperty('totalRequests');
      expect(stats.aggregated).toHaveProperty('totalErrors');
      expect(stats.aggregated).toHaveProperty('averageResponseTime');
      expect(stats.aggregated).toHaveProperty('servicesReporting');

      // Validate aggregated types
      expect(typeof stats.aggregated.totalRequests).toBe('number');
      expect(typeof stats.aggregated.totalErrors).toBe('number');
      expect(typeof stats.aggregated.averageResponseTime).toBe('number');
      expect(typeof stats.aggregated.servicesReporting).toBe('number');

      // Values should be non-negative
      expect(stats.aggregated.totalRequests).toBeGreaterThanOrEqual(0);
      expect(stats.aggregated.totalErrors).toBeGreaterThanOrEqual(0);
      expect(stats.aggregated.averageResponseTime).toBeGreaterThanOrEqual(0);
      expect(stats.aggregated.servicesReporting).toBeGreaterThanOrEqual(0);
    });

    it('should return valid ServiceStats structure for each service', async () => {
      const stats = await integration.collectStats();

      [stats.services.decisionService, stats.services.generationService].forEach(serviceStats => {
        if (serviceStats) {
          expect(serviceStats).toHaveProperty('serviceName');
          expect(serviceStats).toHaveProperty('timestamp');
          expect(serviceStats).toHaveProperty('stats');

          expect(typeof serviceStats.serviceName).toBe('string');
          expect(serviceStats.timestamp).toBeInstanceOf(Date);
          expect(typeof serviceStats.stats).toBe('object');
        }
      });
    });
  });

  /**
   * Property 6.6: Dashboard stats structure validation
   * Dashboard stats should provide comprehensive view of all services.
   * Validates: Requirements 7.4
   */
  describe('Property 6.6: Dashboard stats structure validation', () => {
    it('should return valid dashboard stats structure', async () => {
      const dashboardStats = await integration.getDashboardStats();

      // Validate top-level structure
      expect(dashboardStats).toHaveProperty('timestamp');
      expect(dashboardStats).toHaveProperty('decisionService');
      expect(dashboardStats).toHaveProperty('generationService');
      expect(dashboardStats).toHaveProperty('aggregated');

      // Validate timestamp
      expect(dashboardStats.timestamp).toBeInstanceOf(Date);

      // Validate service structures
      [dashboardStats.decisionService, dashboardStats.generationService].forEach(service => {
        expect(service).toHaveProperty('available');
        expect(service).toHaveProperty('stats');
        expect(service).toHaveProperty('health');

        expect(typeof service.available).toBe('boolean');
        expect(typeof service.stats).toBe('object');
      });

      // Validate aggregated structure
      expect(dashboardStats.aggregated).toHaveProperty('totalRequests');
      expect(dashboardStats.aggregated).toHaveProperty('totalErrors');
      expect(dashboardStats.aggregated).toHaveProperty('errorRate');
      expect(dashboardStats.aggregated).toHaveProperty('averageResponseTime');
      expect(dashboardStats.aggregated).toHaveProperty('servicesHealthy');
      expect(dashboardStats.aggregated).toHaveProperty('servicesTotal');

      // Validate aggregated types and constraints
      expect(typeof dashboardStats.aggregated.errorRate).toBe('number');
      expect(dashboardStats.aggregated.errorRate).toBeGreaterThanOrEqual(0);
      expect(dashboardStats.aggregated.errorRate).toBeLessThanOrEqual(100);
      expect(dashboardStats.aggregated.servicesHealthy).toBeLessThanOrEqual(
        dashboardStats.aggregated.servicesTotal
      );
    });
  });

  /**
   * Property 6.7: Configuration management validation
   * Configuration should be properly managed and retrievable.
   * Validates: Requirements 9.1, 9.2
   */
  describe('Property 6.7: Configuration management validation', () => {
    it('should return valid configuration structure', () => {
      const config = integration.getConfig();

      // Validate top-level structure
      expect(config).toHaveProperty('decisionService');
      expect(config).toHaveProperty('generationService');
      expect(config).toHaveProperty('ttsService');
      expect(config).toHaveProperty('live2dService');
      expect(config).toHaveProperty('danmakuService');
      expect(config).toHaveProperty('healthCheckTimeout');
      expect(config).toHaveProperty('statsCollectionInterval');

      // Validate service configs
      const serviceConfigs = [
        config.decisionService,
        config.generationService,
        config.ttsService,
        config.live2dService,
        config.danmakuService
      ];

      serviceConfigs.forEach(serviceConfig => {
        expect(serviceConfig).toHaveProperty('name');
        expect(serviceConfig).toHaveProperty('url');
        expect(serviceConfig).toHaveProperty('healthEndpoint');
        expect(serviceConfig).toHaveProperty('timeout');

        expect(typeof serviceConfig.name).toBe('string');
        expect(typeof serviceConfig.url).toBe('string');
        expect(typeof serviceConfig.healthEndpoint).toBe('string');
        expect(typeof serviceConfig.timeout).toBe('number');
        expect(serviceConfig.timeout).toBeGreaterThan(0);
      });
    });

    it('should update configuration correctly', () => {
      const newTimeout = 45000;
      integration.updateConfig({ healthCheckTimeout: newTimeout });

      const config = integration.getConfig();
      expect(config.healthCheckTimeout).toBe(newTimeout);
    });

    it('should get service configuration by name', () => {
      const decisionConfig = integration.getServiceConfig('decision');
      const generationConfig = integration.getServiceConfig('generation');

      expect(decisionConfig).toBeDefined();
      expect(decisionConfig?.name).toBe('DecisionService');

      expect(generationConfig).toBeDefined();
      expect(generationConfig?.name).toBe('GenerationService');
    });

    it('should update service configuration', () => {
      const newTimeout = 10000;
      const success = integration.updateServiceConfig('decision', { timeout: newTimeout });

      expect(success).toBe(true);

      const config = integration.getServiceConfig('decision');
      expect(config?.timeout).toBe(newTimeout);
    });

    it('should return false for invalid service name', () => {
      const success = integration.updateServiceConfig('invalid', { timeout: 5000 });
      expect(success).toBe(false);
    });
  });

  /**
   * Property 6.8: Lifecycle management validation
   * Integration should properly manage start/stop lifecycle.
   */
  describe('Property 6.8: Lifecycle management validation', () => {
    it('should report correct running state', () => {
      expect(integration.isIntegrationRunning()).toBe(false);

      integration.start();
      expect(integration.isIntegrationRunning()).toBe(true);

      integration.stop();
      expect(integration.isIntegrationRunning()).toBe(false);
    });

    it('should handle multiple start calls gracefully', () => {
      expect(() => {
        integration.start();
        integration.start();
        integration.start();
      }).not.toThrow();

      expect(integration.isIntegrationRunning()).toBe(true);
      integration.stop();
    });

    it('should handle multiple stop calls gracefully', () => {
      integration.start();

      expect(() => {
        integration.stop();
        integration.stop();
        integration.stop();
      }).not.toThrow();

      expect(integration.isIntegrationRunning()).toBe(false);
    });
  });

  /**
   * Property 6.9: Last results caching
   * Last health check and stats should be cached and retrievable.
   */
  describe('Property 6.9: Last results caching', () => {
    it('should cache last health check result', async () => {
      // Initially null
      expect(integration.getLastHealthCheck()).toBeNull();

      // After health check, should be cached
      await integration.performHealthCheck();
      const cached = integration.getLastHealthCheck();

      expect(cached).not.toBeNull();
      expect(cached).toHaveProperty('timestamp');
      expect(cached).toHaveProperty('overallStatus');
    });

    it('should cache last stats result', async () => {
      // Initially null
      expect(integration.getLastStats()).toBeNull();

      // After stats collection, should be cached
      await integration.collectStats();
      const cached = integration.getLastStats();

      expect(cached).not.toBeNull();
      expect(cached).toHaveProperty('timestamp');
      expect(cached).toHaveProperty('aggregated');
    });
  });
});

/**
 * Property 6.10: Configuration value constraints
 * Configuration values should satisfy reasonable constraints.
 */
describe('Feature: nn-llm-separation, Property 6: Configuration constraints', () => {
  it('should enforce positive timeout values', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60000 }),
        (timeout) => {
          const integration = new ManagerServerIntegration({
            healthCheckTimeout: timeout
          });

          const config = integration.getConfig();
          expect(config.healthCheckTimeout).toBe(timeout);
          expect(config.healthCheckTimeout).toBeGreaterThan(0);

          integration.stop();
          return true;
        }
      ),
      { numRuns: TEST_ITERATIONS }
    );
  });

  it('should preserve service URL format', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'http://localhost:8080',
          'http://localhost:4007',
          'http://127.0.0.1:8080',
          'http://192.168.1.1:8080'
        ),
        (url) => {
          const integration = new ManagerServerIntegration({
            decisionService: {
              name: 'DecisionService',
              url,
              healthEndpoint: '/health',
              timeout: 5000
            }
          });

          const config = integration.getConfig();
          expect(config.decisionService.url).toBe(url);
          expect(config.decisionService.url).toMatch(/^https?:\/\//);

          integration.stop();
          return true;
        }
      ),
      { numRuns: 20 }
    );
  });
});

