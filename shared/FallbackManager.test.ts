/**
 * Unit Tests for Fallback Manager
 * Tests timeout handling, retry logic, and fallback responses
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  FallbackManager,
  TIMEOUT_CONFIG,
  RETRY_CONFIG,
  resetGlobalFallbackManager,
} from './FallbackManager';
import { FallbackLogger, resetGlobalLogger } from './FallbackLogger';
import { FALLBACK_MESSAGE } from './FallbackTemplate';

describe('FallbackManager', () => {
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

  describe('executeWithFallback', () => {
    it('should return result on success', async () => {
      const result = await manager.executeWithFallback(
        'TEST_SERVICE',
        async () => 'success',
        'fallback',
        1000
      );

      expect(result).toBe('success');
    });

    it('should return fallback value on timeout', async () => {
      const result = await manager.executeWithFallback(
        'TEST_SERVICE',
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return 'success';
        },
        'fallback',
        100
      );

      expect(result).toBe('fallback');
    });

    it('should return fallback value on error', async () => {
      const result = await manager.executeWithFallback(
        'TEST_SERVICE',
        async () => {
          throw new Error('Service error');
        },
        'fallback',
        1000
      );

      expect(result).toBe('fallback');
    });

    it('should log fallback events', async () => {
      const initialCount = logger.getLogCount();

      await manager.executeWithFallback(
        'TEST_SERVICE',
        async () => {
          throw new Error('Service error');
        },
        'fallback',
        1000
      );

      expect(logger.getLogCount()).toBeGreaterThan(initialCount);
    });
  });

  describe('retry logic', () => {
    it('should retry on failure for critical services', async () => {
      let attempts = 0;

      const result = await manager.executeWithFallback(
        'LLM',
        async () => {
          attempts++;
          if (attempts < 2) {
            throw new Error('Temporary error');
          }
          return 'success';
        },
        'fallback',
        1000
      );

      expect(result).toBe('success');
      expect(attempts).toBe(2);
    });

    it('should return fallback after max retries', async () => {
      let attempts = 0;

      const result = await manager.executeWithFallback(
        'LLM',
        async () => {
          attempts++;
          throw new Error('Persistent error');
        },
        'fallback',
        1000
      );

      expect(result).toBe('fallback');
      expect(attempts).toBeGreaterThan(1);
    });
  });

  describe('getFallbackResponse', () => {
    it('should return fallback response with correct message', () => {
      const response = manager.getFallbackResponse('TEST_REASON');

      expect(response.success).toBe(false);
      expect(response.text).toBe(FALLBACK_MESSAGE);
      expect(response.fallbackReason).toBe('TEST_REASON');
    });

    it('should include error message in fallback response', () => {
      const error = new Error('Test error');
      const response = manager.getFallbackResponse('TEST_REASON', error);

      expect(response.error).toBe('Test error');
    });
  });

  describe('isServiceAvailable', () => {
    it('should return false for unavailable service', async () => {
      const available = await manager.isServiceAvailable(
        'TEST_SERVICE',
        'http://localhost:9999'
      );

      expect(available).toBe(false);
    });
  });

  describe('getStatistics', () => {
    it('should track fallback statistics', async () => {
      await manager.executeWithFallback(
        'TEST_SERVICE',
        async () => {
          throw new Error('Service error');
        },
        'fallback',
        1000
      );

      const stats = manager.getStatistics();

      expect(stats.totalFallbacks).toBeGreaterThan(0);
      expect(stats.fallbacksByService['TEST_SERVICE']).toBeGreaterThan(0);
    });
  });

  describe('timeout configuration', () => {
    it('should use configured timeout for LLM', async () => {
      const timeout = TIMEOUT_CONFIG['LLM'];
      expect(timeout).toBe(5000);
    });

    it('should use configured timeout for TTS', async () => {
      const timeout = TIMEOUT_CONFIG['TTS'];
      expect(timeout).toBe(8000);
    });

    it('should use configured timeout for non-critical services', async () => {
      const timeout = TIMEOUT_CONFIG['BRAINNN'];
      expect(timeout).toBe(3000);
    });
  });

  describe('retry configuration', () => {
    it('should have retry config for LLM', () => {
      const config = RETRY_CONFIG['LLM'];
      expect(config).toBeDefined();
      expect(config.maxRetries).toBeGreaterThan(0);
    });

    it('should have retry config for TTS', () => {
      const config = RETRY_CONFIG['TTS'];
      expect(config).toBeDefined();
      expect(config.maxRetries).toBeGreaterThan(0);
    });
  });
});
