/**
 * Unit Tests for Error Categories
 * Tests error categorization and severity levels
 */

import { describe, it, expect } from '@jest/globals';
import {
  ErrorCategory,
  ErrorSeverity,
  categorizeError,
  getSeverity,
  isCriticalError,
  isNonCriticalError,
  createErrorContext,
} from './ErrorCategories';

describe('ErrorCategories', () => {
  describe('categorizeError', () => {
    it('should categorize timeout errors', () => {
      const error = new Error('Operation timeout after 5000ms');
      const category = categorizeError('LLM', error);

      expect(category).toBe(ErrorCategory.SERVICE_TIMEOUT);
    });

    it('should categorize connection refused errors', () => {
      const error = new Error('ECONNREFUSED: Connection refused');
      const category = categorizeError('LLM', error);

      expect(category).toBe(ErrorCategory.CONNECTION_REFUSED);
    });

    it('should categorize DNS resolution errors', () => {
      const error = new Error('ENOTFOUND: getaddrinfo ENOTFOUND');
      const category = categorizeError('LLM', error);

      expect(category).toBe(ErrorCategory.DNS_RESOLUTION_FAILED);
    });

    it('should categorize LLM service errors', () => {
      const error = new Error('LLM service unavailable');
      const category = categorizeError('LLM', error);

      expect(category).toBe(ErrorCategory.LLM_UNAVAILABLE);
    });

    it('should categorize TTS service errors', () => {
      const error = new Error('TTS service error');
      const category = categorizeError('TTS', error);

      expect(category).toBe(ErrorCategory.TTS_UNAVAILABLE);
    });

    it('should categorize BrainNN service errors', () => {
      const error = new Error('BrainNN connection failed');
      const category = categorizeError('BrainNN', error);

      expect(category).toBe(ErrorCategory.BRAINNN_UNAVAILABLE);
    });

    it('should categorize Prediction Engine errors', () => {
      const error = new Error('Prediction Engine service error');
      const category = categorizeError('Prediction', error);

      expect(category).toBe(ErrorCategory.PREDICTION_ENGINE_UNAVAILABLE);
    });

    it('should categorize Memory System errors', () => {
      const error = new Error('Memory System unavailable');
      const category = categorizeError('Memory', error);

      expect(category).toBe(ErrorCategory.MEMORY_SYSTEM_UNAVAILABLE);
    });

    it('should categorize Agent Core errors', () => {
      const error = new Error('Agent Core error');
      const category = categorizeError('Agent', error);

      expect(category).toBe(ErrorCategory.AGENT_CORE_UNAVAILABLE);
    });

    it('should categorize Neuro-Symbolic errors', () => {
      const error = new Error('Neuro-Symbolic Bridge error');
      const category = categorizeError('Neuro', error);

      expect(category).toBe(ErrorCategory.NEURO_SYMBOLIC_UNAVAILABLE);
    });

    it('should categorize Reflection Engine errors', () => {
      const error = new Error('Reflection Engine service error');
      const category = categorizeError('Reflection', error);

      expect(category).toBe(ErrorCategory.REFLECTION_ENGINE_UNAVAILABLE);
    });

    it('should default to UNKNOWN_ERROR for unrecognized services', () => {
      const error = new Error('Unknown service error');
      const category = categorizeError('UnknownService', error);

      expect(category).toBe(ErrorCategory.UNKNOWN_ERROR);
    });
  });

  describe('getSeverity', () => {
    it('should return CRITICAL for LLM errors', () => {
      const severity = getSeverity(ErrorCategory.LLM_UNAVAILABLE);
      expect(severity).toBe(ErrorSeverity.CRITICAL);
    });

    it('should return CRITICAL for TTS errors', () => {
      const severity = getSeverity(ErrorCategory.TTS_UNAVAILABLE);
      expect(severity).toBe(ErrorSeverity.CRITICAL);
    });

    it('should return WARNING for non-critical service errors', () => {
      const severity = getSeverity(ErrorCategory.BRAINNN_UNAVAILABLE);
      expect(severity).toBe(ErrorSeverity.WARNING);
    });

    it('should return WARNING for Prediction Engine errors', () => {
      const severity = getSeverity(ErrorCategory.PREDICTION_ENGINE_UNAVAILABLE);
      expect(severity).toBe(ErrorSeverity.WARNING);
    });

    it('should return WARNING for Memory System errors', () => {
      const severity = getSeverity(ErrorCategory.MEMORY_SYSTEM_UNAVAILABLE);
      expect(severity).toBe(ErrorSeverity.WARNING);
    });

    it('should return ERROR for unknown errors', () => {
      const severity = getSeverity(ErrorCategory.UNKNOWN_ERROR);
      expect(severity).toBe(ErrorSeverity.ERROR);
    });
  });

  describe('isCriticalError', () => {
    it('should return true for LLM errors', () => {
      expect(isCriticalError(ErrorCategory.LLM_UNAVAILABLE)).toBe(true);
    });

    it('should return true for TTS errors', () => {
      expect(isCriticalError(ErrorCategory.TTS_UNAVAILABLE)).toBe(true);
    });

    it('should return false for non-critical errors', () => {
      expect(isCriticalError(ErrorCategory.BRAINNN_UNAVAILABLE)).toBe(false);
      expect(isCriticalError(ErrorCategory.PREDICTION_ENGINE_UNAVAILABLE)).toBe(
        false
      );
      expect(isCriticalError(ErrorCategory.MEMORY_SYSTEM_UNAVAILABLE)).toBe(
        false
      );
    });
  });

  describe('isNonCriticalError', () => {
    it('should return true for non-critical service errors', () => {
      expect(isNonCriticalError(ErrorCategory.BRAINNN_UNAVAILABLE)).toBe(true);
      expect(isNonCriticalError(ErrorCategory.PREDICTION_ENGINE_UNAVAILABLE)).toBe(
        true
      );
      expect(isNonCriticalError(ErrorCategory.MEMORY_SYSTEM_UNAVAILABLE)).toBe(
        true
      );
      expect(isNonCriticalError(ErrorCategory.AGENT_CORE_UNAVAILABLE)).toBe(true);
      expect(isNonCriticalError(ErrorCategory.NEURO_SYMBOLIC_UNAVAILABLE)).toBe(
        true
      );
      expect(isNonCriticalError(ErrorCategory.REFLECTION_ENGINE_UNAVAILABLE)).toBe(
        true
      );
    });

    it('should return false for critical errors', () => {
      expect(isNonCriticalError(ErrorCategory.LLM_UNAVAILABLE)).toBe(false);
      expect(isNonCriticalError(ErrorCategory.TTS_UNAVAILABLE)).toBe(false);
    });
  });

  describe('createErrorContext', () => {
    it('should create error context with correct properties', () => {
      const error = new Error('Test error');
      const context = createErrorContext('TestService', error);

      expect(context.serviceName).toBe('TestService');
      expect(context.originalError).toBe(error);
      expect(context.timestamp).toBeGreaterThan(0);
      expect(context.category).toBeDefined();
      expect(context.severity).toBeDefined();
    });

    it('should include details in error context', () => {
      const error = new Error('Test error');
      const details = { code: 500, message: 'Internal Server Error' };
      const context = createErrorContext('TestService', error, details);

      expect(context.details).toEqual(details);
    });

    it('should set correct severity based on category', () => {
      const llmError = new Error('LLM error');
      const llmContext = createErrorContext('LLM', llmError);

      expect(llmContext.severity).toBe(ErrorSeverity.CRITICAL);

      const brainnnError = new Error('BrainNN error');
      const brainnnContext = createErrorContext('BrainNN', brainnnError);

      expect(brainnnContext.severity).toBe(ErrorSeverity.WARNING);
    });
  });
});
