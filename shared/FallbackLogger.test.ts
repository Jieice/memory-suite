/**
 * Unit Tests for Fallback Logger
 * Tests logging functionality, metrics recording, and statistics collection
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  FallbackLogger,
  FallbackEvent,
  FallbackStatistics,
  resetGlobalLogger,
} from './FallbackLogger';
import { ErrorCategory, ErrorSeverity } from './ErrorCategories';

describe('FallbackLogger', () => {
  let logger: FallbackLogger;

  beforeEach(() => {
    resetGlobalLogger();
    logger = new FallbackLogger();
  });

  describe('logFallback', () => {
    it('should log fallback event', () => {
      const initialCount = logger.getLogCount();

      logger.logFallback(
        'TEST_SERVICE',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Test reason'
      );

      expect(logger.getLogCount()).toBe(initialCount + 1);
    });

    it('should include error message in log', () => {
      const error = new Error('Test error');
      logger.logFallback(
        'TEST_SERVICE',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Test reason',
        error
      );

      const events = logger.getEvents();
      expect(events[0].error).toBe('Test error');
    });

    it('should include details in log', () => {
      const details = { code: 500, message: 'Internal Server Error' };
      logger.logFallback(
        'TEST_SERVICE',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Test reason',
        undefined,
        details
      );

      const events = logger.getEvents();
      expect(events[0].details).toEqual(details);
    });
  });

  describe('getEvents', () => {
    it('should return all logged events', () => {
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );
      logger.logFallback(
        'SERVICE2',
        ErrorCategory.TTS_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 2'
      );

      const events = logger.getEvents();
      expect(events.length).toBe(2);
    });

    it('should return copy of events array', () => {
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );

      const events1 = logger.getEvents();
      const events2 = logger.getEvents();

      expect(events1).not.toBe(events2);
      expect(events1).toEqual(events2);
    });
  });

  describe('getStatistics', () => {
    it('should track total fallbacks', () => {
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );
      logger.logFallback(
        'SERVICE2',
        ErrorCategory.TTS_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 2'
      );

      const stats = logger.getStatistics();
      expect(stats.totalFallbacks).toBe(2);
    });

    it('should track fallbacks by service', () => {
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 2'
      );
      logger.logFallback(
        'SERVICE2',
        ErrorCategory.TTS_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 3'
      );

      const stats = logger.getStatistics();
      expect(stats.fallbacksByService['SERVICE1']).toBe(2);
      expect(stats.fallbacksByService['SERVICE2']).toBe(1);
    });

    it('should track fallbacks by category', () => {
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );
      logger.logFallback(
        'SERVICE2',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 2'
      );
      logger.logFallback(
        'SERVICE3',
        ErrorCategory.TTS_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 3'
      );

      const stats = logger.getStatistics();
      expect(stats.fallbacksByCategory[ErrorCategory.LLM_UNAVAILABLE]).toBe(2);
      expect(stats.fallbacksByCategory[ErrorCategory.TTS_UNAVAILABLE]).toBe(1);
    });

    it('should track fallbacks by severity', () => {
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );
      logger.logFallback(
        'SERVICE2',
        ErrorCategory.BRAINNN_UNAVAILABLE,
        ErrorSeverity.WARNING,
        'Reason 2'
      );

      const stats = logger.getStatistics();
      expect(stats.fallbacksBySeverity[ErrorSeverity.CRITICAL]).toBe(1);
      expect(stats.fallbacksBySeverity[ErrorSeverity.WARNING]).toBe(1);
    });

    it('should track last fallback time', () => {
      const before = Date.now();
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );
      const after = Date.now();

      const stats = logger.getStatistics();
      expect(stats.lastFallbackTime).toBeGreaterThanOrEqual(before);
      expect(stats.lastFallbackTime).toBeLessThanOrEqual(after);
    });

    it('should track first fallback time', () => {
      const before = Date.now();
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );
      const after = Date.now();

      const stats = logger.getStatistics();
      expect(stats.firstFallbackTime).toBeGreaterThanOrEqual(before);
      expect(stats.firstFallbackTime).toBeLessThanOrEqual(after);
    });
  });

  describe('getEventsByService', () => {
    it('should return events for specific service', () => {
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );
      logger.logFallback(
        'SERVICE2',
        ErrorCategory.TTS_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 2'
      );
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 3'
      );

      const events = logger.getEventsByService('SERVICE1');
      expect(events.length).toBe(2);
      expect(events.every((e) => e.serviceName === 'SERVICE1')).toBe(true);
    });
  });

  describe('getEventsByCategory', () => {
    it('should return events for specific category', () => {
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );
      logger.logFallback(
        'SERVICE2',
        ErrorCategory.TTS_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 2'
      );
      logger.logFallback(
        'SERVICE3',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 3'
      );

      const events = logger.getEventsByCategory(ErrorCategory.LLM_UNAVAILABLE);
      expect(events.length).toBe(2);
      expect(events.every((e) => e.category === ErrorCategory.LLM_UNAVAILABLE)).toBe(
        true
      );
    });
  });

  describe('getEventsBySeverity', () => {
    it('should return events for specific severity', () => {
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );
      logger.logFallback(
        'SERVICE2',
        ErrorCategory.BRAINNN_UNAVAILABLE,
        ErrorSeverity.WARNING,
        'Reason 2'
      );
      logger.logFallback(
        'SERVICE3',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 3'
      );

      const events = logger.getEventsBySeverity(ErrorSeverity.CRITICAL);
      expect(events.length).toBe(2);
      expect(events.every((e) => e.severity === ErrorSeverity.CRITICAL)).toBe(true);
    });
  });

  describe('getEventsByTimeRange', () => {
    it('should return events within time range', async () => {
      const before = Date.now();

      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      const middle = Date.now();

      logger.logFallback(
        'SERVICE2',
        ErrorCategory.TTS_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 2'
      );

      const after = Date.now();

      const events = logger.getEventsByTimeRange(middle, after);
      expect(events.length).toBe(1);
      expect(events[0].serviceName).toBe('SERVICE2');
    });
  });

  describe('clear', () => {
    it('should clear all events', () => {
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );

      expect(logger.getLogCount()).toBe(1);

      logger.clear();

      expect(logger.getLogCount()).toBe(0);
      expect(logger.getStatistics().totalFallbacks).toBe(0);
    });
  });

  describe('exportPrometheusMetrics', () => {
    it('should export metrics in Prometheus format', () => {
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );

      const metrics = logger.exportPrometheusMetrics();

      expect(metrics).toContain('fallback_total');
      expect(metrics).toContain('fallback_by_service');
      expect(metrics).toContain('fallback_by_category');
      expect(metrics).toContain('fallback_by_severity');
    });

    it('should include service names in metrics', () => {
      logger.logFallback(
        'SERVICE1',
        ErrorCategory.LLM_UNAVAILABLE,
        ErrorSeverity.CRITICAL,
        'Reason 1'
      );

      const metrics = logger.exportPrometheusMetrics();

      expect(metrics).toContain('SERVICE1');
    });
  });
});
