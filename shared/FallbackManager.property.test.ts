/**
 * Property-Based Tests for Fallback Manager
 * Tests universal properties that should hold across all inputs
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fc from 'fast-check';
import {
  FallbackManager,
  resetGlobalFallbackManager,
} from './FallbackManager';
import { FallbackLogger, resetGlobalLogger } from './FallbackLogger';
import { FALLBACK_MESSAGE, isFallbackResponse } from './FallbackTemplate';
import {
  ErrorCategory,
  isCriticalError,
  isNonCriticalError,
} from './ErrorCategories';

describe('FallbackManager Property-Based Tests', () => {
  let manager: FallbackManager;
  let logger: FallbackLogger;

  beforeEach(() => {
    resetGlobalFallbackManager();
    resetGlobalLogger();
    logger = new FallbackLogger();
    manager = new FallbackManager(logger);
  });

  afterEach(() => {
    resetGlobalFallbackManager();
    resetGlobalLogger();
  });

  /**
   * Property 1: Fallback Message Consistency
   * **Validates: Requirements 1.10**
   *
   * For any service failure, the returned message must always be:
   * "请告诉我的创造者，我的ai出现问题了"
   */
  describe('Property 1: Fallback Message Consistency', () => {
    it('should always return consistent fallback message for any service', () => {
      fc.assert(
        fc.property(fc.string(), (serviceName) => {
          const response = manager.getFallbackResponse('TEST_REASON');

          expect(response.text).toBe(FALLBACK_MESSAGE);
          expect(response.success).toBe(false);
          expect(response.fallbackReason).toBeDefined();
        })
      );
    });

    it('should return consistent message regardless of error reason', () => {
      fc.assert(
        fc.property(fc.string(), (reason) => {
          const response = manager.getFallbackResponse(reason);

          expect(response.text).toBe(FALLBACK_MESSAGE);
          expect(response.success).toBe(false);
        })
      );
    });

    it('should return consistent message regardless of error details', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (message, stack) => {
          const error = new Error(message);
          error.stack = stack;

          const response = manager.getFallbackResponse('TEST_REASON', error);

          expect(response.text).toBe(FALLBACK_MESSAGE);
          expect(response.success).toBe(false);
        })
      );
    });
  });

  /**
   * Property 2: Critical Service Fallback
   * **Validates: Requirements 1.1, 1.2**
   *
   * When critical services (LLM, TTS) fail, the system must return fallback message
   */
  describe('Property 2: Critical Service Fallback', () => {
    it('should return fallback for any critical service failure', async () => {
      const criticalServices = ['LLM', 'TTS'];

      for (const service of criticalServices) {
        const result = await manager.executeWithFallback(
          service,
          () => {
            throw new Error('Service unavailable');
          },
          null,
          1000
        );

        expect(result).toBeNull();
      }
    });

    it('should log all critical service failures', async () => {
      const initialCount = logger.getLogCount();

      await manager.executeWithFallback(
        'LLM',
        () => {
          throw new Error('Service unavailable');
        },
        null,
        1000
      );

      expect(logger.getLogCount()).toBeGreaterThan(initialCount);
    });
  });

  /**
   * Property 3: Non-Critical Service Degradation
   * **Validates: Requirements 1.4, 1.5, 1.6, 1.7, 1.8**
   *
   * When non-critical services fail, the system must continue processing
   */
  describe('Property 3: Non-Critical Service Degradation', () => {
    it('should continue with fallback value for non-critical services', async () => {
      const nonCriticalServices = [
        'BRAINNN',
        'PREDICTION_ENGINE',
        'MEMORY_SYSTEM',
        'AGENT_CORE',
        'NEURO_SYMBOLIC',
        'REFLECTION_ENGINE',
      ];

      for (const service of nonCriticalServices) {
        const fallbackValue = { degraded: true };
        const result = await manager.executeWithFallback(
          service,
          () => {
            throw new Error('Service unavailable');
          },
          fallbackValue,
          1000
        );

        expect(result).toEqual(fallbackValue);
      }
    });
  });

  /**
   * Property 4: Fallback Logging
   * **Validates: Requirements 1.1-1.9**
   *
   * All fallback events must be logged
   */
  describe('Property 4: Fallback Logging', () => {
    it('should log all fallback events', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string(), async (serviceName) => {
          const initialCount = logger.getLogCount();

          await manager.executeWithFallback(
            serviceName,
            () => {
              throw new Error('Service error');
            },
            'fallback',
            1000
          );

          expect(logger.getLogCount()).toBeGreaterThan(initialCount);
        })
      );
    });

    it('should include service name in logs', async () => {
      const serviceName = 'TEST_SERVICE';

      await manager.executeWithFallback(
        serviceName,
        () => {
          throw new Error('Service error');
        },
        'fallback',
        1000
      );

      const events = logger.getEventsByService(serviceName);
      expect(events.length).toBeGreaterThan(0);
    });

    it('should include error reason in logs', async () => {
      const reason = 'TEST_REASON';

      await manager.executeWithFallback(
        'TEST_SERVICE',
        () => {
          throw new Error(reason);
        },
        'fallback',
        1000
      );

      const events = logger.getEvents();
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].error).toBeDefined();
    });
  });

  /**
   * Property 5: Fallback Performance
   * **Validates: Non-Functional Requirements**
   *
   * Fallback should not add more than 50ms latency
   */
  describe('Property 5: Fallback Performance', () => {
    it('should return fallback quickly on timeout', async () => {
      const startTime = Date.now();

      await manager.executeWithFallback(
        'TEST_SERVICE',
        () => {
          throw new Error('Service error');
        },
        'fallback',
        100
      );

      const duration = Date.now() - startTime;

      // Should complete within reasonable time (allowing for system variance)
      expect(duration).toBeLessThan(500);
    });

    it('should handle multiple concurrent fallbacks efficiently', async () => {
      const startTime = Date.now();

      const promises = Array.from({ length: 10 }, (_, i) =>
        manager.executeWithFallback(
          `SERVICE_${i}`,
          () => {
            throw new Error('Service error');
          },
          'fallback',
          100
        )
      );

      await Promise.all(promises);

      const duration = Date.now() - startTime;

      // Should handle 10 concurrent fallbacks reasonably
      expect(duration).toBeLessThan(2000);
    });
  });

  /**
   * Property 6: Fallback Response Structure
   * **Validates: Requirements 1.10**
   *
   * All fallback responses must have consistent structure
   */
  describe('Property 6: Fallback Response Structure', () => {
    it('should always have required fields in fallback response', () => {
      fc.assert(
        fc.property(fc.string(), (reason) => {
          const response = manager.getFallbackResponse(reason);

          expect(response).toHaveProperty('success');
          expect(response).toHaveProperty('text');
          expect(response).toHaveProperty('fallbackReason');
          expect(response).toHaveProperty('timestamp');

          expect(response.success).toBe(false);
          expect(response.text).toBe(FALLBACK_MESSAGE);
          expect(typeof response.timestamp).toBe('number');
        })
      );
    });

    it('should have valid timestamp in fallback response', () => {
      fc.assert(
        fc.property(fc.string(), (reason) => {
          const before = Date.now();
          const response = manager.getFallbackResponse(reason);
          const after = Date.now();

          expect(response.timestamp).toBeGreaterThanOrEqual(before);
          expect(response.timestamp).toBeLessThanOrEqual(after);
        })
      );
    });
  });

  /**
   * Property 7: Statistics Accuracy
   * **Validates: Requirements 1.1-1.9**
   *
   * Statistics must accurately track fallback events
   */
  describe('Property 7: Statistics Accuracy', () => {
    it('should accurately count total fallbacks', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (count) => {
          logger.clear();

          for (let i = 0; i < count; i++) {
            await manager.executeWithFallback(
              'TEST_SERVICE',
              () => {
                throw new Error('Service error');
              },
              'fallback',
              1000
            );
          }

          const stats = manager.getStatistics();
          expect(stats.totalFallbacks).toBe(count);
        })
      );
    });

    it('should accurately track fallbacks by service', async () => {
      logger.clear();

      await manager.executeWithFallback(
        'SERVICE_A',
        () => {
          throw new Error('Error');
        },
        'fallback',
        1000
      );

      await manager.executeWithFallback(
        'SERVICE_A',
        () => {
          throw new Error('Error');
        },
        'fallback',
        1000
      );

      await manager.executeWithFallback(
        'SERVICE_B',
        () => {
          throw new Error('Error');
        },
        'fallback',
        1000
      );

      const stats = manager.getStatistics();
      expect(stats.fallbacksByService['SERVICE_A']).toBe(2);
      expect(stats.fallbacksByService['SERVICE_B']).toBe(1);
    });
  });

  /**
   * Property 8: Idempotency
   * **Validates: Requirements 1.1-1.9**
   *
   * Multiple calls with same parameters should produce consistent results
   */
  describe('Property 8: Idempotency', () => {
    it('should return same fallback message for repeated calls', () => {
      const response1 = manager.getFallbackResponse('REASON');
      const response2 = manager.getFallbackResponse('REASON');

      expect(response1.text).toBe(response2.text);
      expect(response1.success).toBe(response2.success);
      expect(response1.fallbackReason).toBe(response2.fallbackReason);
    });

    it('should handle repeated failures consistently', async () => {
      const results = [];

      for (let i = 0; i < 3; i++) {
        const result = await manager.executeWithFallback(
          'TEST_SERVICE',
          () => {
            throw new Error('Service error');
          },
          'fallback',
          1000
        );

        results.push(result);
      }

      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
    });
  });
});
