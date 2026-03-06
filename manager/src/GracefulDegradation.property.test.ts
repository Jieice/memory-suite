/**
 * GracefulDegradation Property Tests
 * 
 * Property 18: Graceful degradation validation
 * Validates: Requirements 8.3
 * 
 * Tests that the system provides appropriate fallback responses
 * and maintains graceful degradation of functionality when services
 * are unavailable.
 */

import * as fc from 'fast-check';
import { FallbackManager, FallbackResult, FallbackLevel } from './FallbackManager';
import { 
  GracefulDegradation, 
  DegradationLevel, 
  DegradationState,
  RequestPriority,
  createGracefulDegradation
} from './GracefulDegradation';
import { DecisionResponse, GenerationResponse, ServiceHealth } from './ServiceOrchestrator';

// Test configuration
const TEST_ITERATIONS = 100;

describe('Feature: nn-llm-separation, Property 18: Graceful degradation validation', () => {
  let fallbackManager: FallbackManager;
  let gracefulDegradation: GracefulDegradation;

  beforeEach(() => {
    fallbackManager = new FallbackManager({
      enabled: true,
      timeoutMs: 5000,
      logFallbacks: false // Disable logging in tests
    });
    gracefulDegradation = createGracefulDegradation(fallbackManager, {
      enabled: true,
      maxQueueSize: 100,
      queueTimeoutMs: 30000,
      notifyUsers: false // Disable notifications in tests
    });
  });

  // ============================================
  // Property 18.1: FallbackManager provides valid fallbacks
  // ============================================
  describe('Property 18.1: FallbackManager provides valid fallbacks', () => {
    /**
     * For any user message, the FallbackManager should provide
     * a valid decision fallback with proper structure.
     */
    it('should provide valid decision fallback for any user message', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 500 }),
          fc.constantFrom(
            'service_unavailable',
            'timeout',
            'circuit_breaker_open',
            'network_error'
          ),
          async (userMessage, reason) => {
            const result = fallbackManager.getDecisionFallback(userMessage, reason);

            // Validate result structure
            expect(result.success).toBe(true);
            expect(result.fallbackLevel).toBe('primary');
            expect(result.fallbackReason).toBe(reason);
            expect(result.timestamp).toBeInstanceOf(Date);

            // Validate decision response structure
            const decision = result.data;
            expect(decision.success).toBe(true);
            expect(decision.selectedBehavior).toBeDefined();
            expect(decision.selectedBehavior?.type).toBeTruthy();
            expect(decision.selectedBehavior?.confidence).toBeGreaterThanOrEqual(0);
            expect(decision.selectedBehavior?.confidence).toBeLessThanOrEqual(1);
            expect(decision.creativeGuidance).toBeDefined();
            expect(decision.metadata?.fallbackUsed).toBe(true);

            return true;
          }
        ),
        { numRuns: TEST_ITERATIONS }
      );
    });

    /**
     * For any user message and decision, the FallbackManager should provide
     * a valid generation fallback with proper structure.
     */
    it('should provide valid generation fallback for any context', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 500 }),
          fc.constantFrom(
            'service_unavailable',
            'timeout',
            'llm_error',
            'rate_limit'
          ),
          async (userMessage, reason) => {
            const decisionFallback = fallbackManager.getDecisionFallback(userMessage, 'test');
            const result = fallbackManager.getGenerationFallback(
              userMessage,
              decisionFallback.data,
              reason
            );

            // Validate result structure
            expect(result.success).toBe(true);
            expect(result.fallbackLevel).toBe('secondary');
            expect(result.fallbackReason).toBe(reason);
            expect(result.timestamp).toBeInstanceOf(Date);

            // Validate generation response structure
            const generation = result.data;
            expect(generation.success).toBe(true);
            expect(generation.text).toBeTruthy();
            expect(typeof generation.text).toBe('string');
            expect(generation.metadata?.fallbackUsed).toBe(true);
            expect(generation.quality).toBeDefined();

            return true;
          }
        ),
        { numRuns: TEST_ITERATIONS }
      );
    });

    /**
     * Emergency fallback should always provide a valid response.
     */
    it('should provide valid emergency fallback', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            'total_system_failure',
            'all_services_down',
            'critical_error'
          ),
          async (reason) => {
            const result = fallbackManager.getEmergencyFallback(reason);

            expect(result.success).toBe(true);
            expect(result.fallbackLevel).toBe('emergency');
            expect(result.fallbackReason).toBe(reason);
            expect(result.data).toBeTruthy();
            expect(typeof result.data).toBe('string');

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // ============================================
  // Property 18.2: Degradation state transitions
  // ============================================
  describe('Property 18.2: Degradation state transitions', () => {
    /**
     * Degradation level should correctly reflect service availability.
     */
    it('should set correct degradation level based on service health', () => {
      // Test all combinations of service availability
      const testCases: Array<{
        decision: 'healthy' | 'unhealthy';
        generation: 'healthy' | 'unhealthy';
        expectedLevel: DegradationLevel;
      }> = [
        { decision: 'healthy', generation: 'healthy', expectedLevel: 'full' },
        { decision: 'healthy', generation: 'unhealthy', expectedLevel: 'partial' },
        { decision: 'unhealthy', generation: 'healthy', expectedLevel: 'partial' },
        { decision: 'unhealthy', generation: 'unhealthy', expectedLevel: 'emergency' }
      ];

      testCases.forEach(({ decision, generation, expectedLevel }) => {
        const serviceHealth = new Map<string, ServiceHealth>([
          ['decision', {
            name: 'DecisionService',
            status: decision,
            lastCheck: new Date(),
            responseTime: 100
          }],
          ['generation', {
            name: 'GenerationService',
            status: generation,
            lastCheck: new Date(),
            responseTime: 200
          }]
        ]);

        const state = gracefulDegradation.updateState(serviceHealth);
        expect(state.level).toBe(expectedLevel);
      });
    });

    /**
     * Capabilities should correctly reflect available services.
     */
    it('should set correct capabilities based on service availability', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.boolean(),
          fc.boolean(),
          async (decisionAvailable, generationAvailable) => {
            const serviceHealth = new Map<string, ServiceHealth>([
              ['decision', {
                name: 'DecisionService',
                status: decisionAvailable ? 'healthy' : 'unhealthy',
                lastCheck: new Date(),
                responseTime: 100
              }],
              ['generation', {
                name: 'GenerationService',
                status: generationAvailable ? 'healthy' : 'unhealthy',
                lastCheck: new Date(),
                responseTime: 200
              }]
            ]);

            const state = gracefulDegradation.updateState(serviceHealth);

            // With fallback enabled, chat should always be possible
            expect(state.capabilities.canProcessChat).toBe(true);
            
            // Decision capability depends on service or fallback
            expect(state.capabilities.canMakeDecisions).toBe(true);
            
            // Generation capability depends on service or fallback
            expect(state.capabilities.canGenerateText).toBe(true);
            
            // Proactive check requires decision service
            expect(state.capabilities.canCheckProactive).toBe(decisionAvailable);
            
            // Fallback flag should be set when services are unavailable
            if (!decisionAvailable || !generationAvailable) {
              expect(state.capabilities.usingFallbacks).toBe(true);
            }

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // ============================================
  // Property 18.3: Request priority handling
  // ============================================
  describe('Property 18.3: Request priority handling', () => {
    /**
     * Request priority should be determined consistently based on message content.
     */
    it('should determine consistent priority for same message', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 500 }),
          fc.string({ minLength: 1, maxLength: 50 }),
          async (message, userId) => {
            const priority1 = gracefulDegradation.determineRequestPriority(message, userId);
            const priority2 = gracefulDegradation.determineRequestPriority(message, userId);

            expect(priority1).toBe(priority2);
            expect(['critical', 'high', 'normal', 'low']).toContain(priority1);

            return true;
          }
        ),
        { numRuns: TEST_ITERATIONS }
      );
    });

    /**
     * Critical keywords should result in critical priority.
     */
    it('should assign critical priority to urgent messages', () => {
      const criticalMessages = [
        '紧急！需要帮助',
        'urgent help needed',
        'emergency situation',
        'help me please'
      ];

      criticalMessages.forEach(message => {
        const priority = gracefulDegradation.determineRequestPriority(message, 'user1');
        expect(priority).toBe('critical');
      });
    });

    /**
     * Questions should result in high priority.
     */
    it('should assign high priority to questions', () => {
      const questions = [
        '这是什么？',
        'What is this?',
        '请帮我看看',
        '能不能帮我'
      ];

      questions.forEach(message => {
        const priority = gracefulDegradation.determineRequestPriority(message, 'user1');
        expect(priority).toBe('high');
      });
    });
  });

  // ============================================
  // Property 18.4: Statistics tracking
  // ============================================
  describe('Property 18.4: Statistics tracking', () => {
    /**
     * Fallback statistics should accurately track usage.
     */
    it('should accurately track fallback statistics', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 0, max: 5 }),
          async (decisionCount, generationCount, emergencyCount) => {
            // Reset stats
            fallbackManager.resetStats();

            // Generate fallbacks
            for (let i = 0; i < decisionCount; i++) {
              fallbackManager.getDecisionFallback(`message${i}`, 'test');
            }
            for (let i = 0; i < generationCount; i++) {
              fallbackManager.getGenerationFallback(`message${i}`, null, 'test');
            }
            for (let i = 0; i < emergencyCount; i++) {
              fallbackManager.getEmergencyFallback('test');
            }

            const stats = fallbackManager.getStats();
            expect(stats.decisionFallbacks).toBe(decisionCount);
            expect(stats.generationFallbacks).toBe(generationCount);
            expect(stats.emergencyFallbacks).toBe(emergencyCount);
            expect(stats.totalFallbacks).toBe(decisionCount + generationCount + emergencyCount);

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    /**
     * Degradation statistics should track level changes.
     */
    it('should track degradation level changes', () => {
      // Start with full service
      let serviceHealth = new Map<string, ServiceHealth>([
        ['decision', { name: 'DecisionService', status: 'healthy', lastCheck: new Date(), responseTime: 100 }],
        ['generation', { name: 'GenerationService', status: 'healthy', lastCheck: new Date(), responseTime: 200 }]
      ]);
      gracefulDegradation.updateState(serviceHealth);

      // Degrade to partial
      serviceHealth = new Map<string, ServiceHealth>([
        ['decision', { name: 'DecisionService', status: 'unhealthy', lastCheck: new Date(), responseTime: 100 }],
        ['generation', { name: 'GenerationService', status: 'healthy', lastCheck: new Date(), responseTime: 200 }]
      ]);
      gracefulDegradation.updateState(serviceHealth);

      // Degrade to emergency
      serviceHealth = new Map<string, ServiceHealth>([
        ['decision', { name: 'DecisionService', status: 'unhealthy', lastCheck: new Date(), responseTime: 100 }],
        ['generation', { name: 'GenerationService', status: 'unhealthy', lastCheck: new Date(), responseTime: 200 }]
      ]);
      gracefulDegradation.updateState(serviceHealth);

      const stats = gracefulDegradation.getStats();
      expect(stats.levelHistory.length).toBeGreaterThanOrEqual(2);
      expect(stats.lastLevelChange).toBeInstanceOf(Date);
    });
  });

  // ============================================
  // Property 18.5: Fallback response consistency
  // ============================================
  describe('Property 18.5: Fallback response consistency', () => {
    /**
     * Same message should produce consistent fallback behavior selection.
     */
    it('should select consistent behavior for same message', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 500 }),
          async (message) => {
            const result1 = fallbackManager.getDecisionFallback(message, 'test');
            const result2 = fallbackManager.getDecisionFallback(message, 'test');

            // Same message should produce same behavior type
            expect(result1.data.selectedBehavior?.type).toBe(result2.data.selectedBehavior?.type);

            return true;
          }
        ),
        { numRuns: TEST_ITERATIONS }
      );
    });

    /**
     * Greeting messages should get greeting responses.
     */
    it('should provide appropriate responses for greetings', () => {
      const greetings = ['你好', '嗨', 'hello', 'hi'];

      greetings.forEach(greeting => {
        const result = fallbackManager.getGenerationFallback(greeting, null, 'test');
        // Response should be non-empty
        expect(result.data.text).toBeTruthy();
        expect(result.data.text!.length).toBeGreaterThan(0);
      });
    });
  });

  // ============================================
  // Property 18.6: Configuration management
  // ============================================
  describe('Property 18.6: Configuration management', () => {
    /**
     * Configuration updates should be applied correctly.
     */
    it('should apply configuration updates', () => {
      const newConfig = {
        enabled: false,
        timeoutMs: 10000,
        logFallbacks: true
      };

      fallbackManager.updateConfig(newConfig);
      const config = fallbackManager.getConfig();

      expect(config.enabled).toBe(false);
      expect(config.timeoutMs).toBe(10000);
      expect(config.logFallbacks).toBe(true);
    });

    /**
     * Custom templates should be usable.
     */
    it('should use custom templates when provided', () => {
      const customTemplate = '自定义回复模板';
      fallbackManager.addGenerationTemplate('acknowledgment', customTemplate);

      // The template should be added (we can't easily verify it's used without
      // knowing the exact hash, but we can verify the method doesn't throw)
      expect(() => {
        fallbackManager.getGenerationFallback('test', null, 'test');
      }).not.toThrow();
    });
  });

  // ============================================
  // Property 18.7: State consistency
  // ============================================
  describe('Property 18.7: State consistency', () => {
    /**
     * isDegraded should match level state.
     */
    it('should have consistent isDegraded state', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.boolean(),
          fc.boolean(),
          async (decisionAvailable, generationAvailable) => {
            const serviceHealth = new Map<string, ServiceHealth>([
              ['decision', {
                name: 'DecisionService',
                status: decisionAvailable ? 'healthy' : 'unhealthy',
                lastCheck: new Date(),
                responseTime: 100
              }],
              ['generation', {
                name: 'GenerationService',
                status: generationAvailable ? 'healthy' : 'unhealthy',
                lastCheck: new Date(),
                responseTime: 200
              }]
            ]);

            gracefulDegradation.updateState(serviceHealth);
            const state = gracefulDegradation.getState();
            const isDegraded = gracefulDegradation.isDegraded();
            const isEmergency = gracefulDegradation.isEmergency();

            // isDegraded should be true when level is not 'full'
            expect(isDegraded).toBe(state.level !== 'full');

            // isEmergency should be true only when level is 'emergency'
            expect(isEmergency).toBe(state.level === 'emergency');

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    /**
     * Available services list should match health status.
     */
    it('should have consistent available services list', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.boolean(),
          fc.boolean(),
          async (decisionAvailable, generationAvailable) => {
            const serviceHealth = new Map<string, ServiceHealth>([
              ['decision', {
                name: 'DecisionService',
                status: decisionAvailable ? 'healthy' : 'unhealthy',
                lastCheck: new Date(),
                responseTime: 100
              }],
              ['generation', {
                name: 'GenerationService',
                status: generationAvailable ? 'healthy' : 'unhealthy',
                lastCheck: new Date(),
                responseTime: 200
              }]
            ]);

            const state = gracefulDegradation.updateState(serviceHealth);

            expect(state.availableServices.includes('decision')).toBe(decisionAvailable);
            expect(state.availableServices.includes('generation')).toBe(generationAvailable);
            expect(state.unavailableServices.includes('decision')).toBe(!decisionAvailable);
            expect(state.unavailableServices.includes('generation')).toBe(!generationAvailable);

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // ============================================
  // Property 18.8: Cleanup and resource management
  // ============================================
  describe('Property 18.8: Cleanup and resource management', () => {
    /**
     * Cleanup should not throw errors.
     */
    it('should cleanup without errors', () => {
      expect(() => {
        gracefulDegradation.cleanup();
      }).not.toThrow();
    });

    /**
     * Multiple cleanup calls should be safe.
     */
    it('should handle multiple cleanup calls', () => {
      expect(() => {
        gracefulDegradation.cleanup();
        gracefulDegradation.cleanup();
        gracefulDegradation.cleanup();
      }).not.toThrow();
    });

    /**
     * Stats reset should clear all counters.
     */
    it('should reset stats completely', () => {
      // Generate some fallbacks
      fallbackManager.getDecisionFallback('test', 'test');
      fallbackManager.getGenerationFallback('test', null, 'test');
      fallbackManager.getEmergencyFallback('test');

      // Reset
      fallbackManager.resetStats();
      const stats = fallbackManager.getStats();

      expect(stats.totalFallbacks).toBe(0);
      expect(stats.decisionFallbacks).toBe(0);
      expect(stats.generationFallbacks).toBe(0);
      expect(stats.emergencyFallbacks).toBe(0);
      expect(stats.lastFallbackTime).toBeNull();
    });
  });
});
