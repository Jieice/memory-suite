/**
 * Unit tests for CircuitBreakerClient (LLM/TTS circuit breakers).
 */

import { runWithLLMCircuitBreaker, runWithTTSCircuitBreaker } from './CircuitBreakerClient';
import { FALLBACK_MESSAGE } from './FallbackTemplate';
import { isFallbackResponse } from './FallbackTemplate';

describe('CircuitBreakerClient', () => {
  describe('runWithLLMCircuitBreaker', () => {
    it('should return result when operation succeeds', async () => {
      const result = await runWithLLMCircuitBreaker(async () => ({ success: true, text: 'ok' }));
      expect(result).toEqual({ success: true, text: 'ok' });
      expect(isFallbackResponse(result)).toBe(false);
    });

    it('should return fallback when operation throws', async () => {
      const result = await runWithLLMCircuitBreaker(async () => {
        throw new Error('LLM unavailable');
      });
      expect(isFallbackResponse(result)).toBe(true);
      if (isFallbackResponse(result)) {
        expect(result.text).toBe(FALLBACK_MESSAGE);
        expect(result.fallbackReason).toBe('circuit_open');
      }
    });
  });

  describe('runWithTTSCircuitBreaker', () => {
    it('should return result when operation succeeds', async () => {
      const result = await runWithTTSCircuitBreaker(async () => ({ data: { audio_url: '/path' } }));
      expect(result).toEqual({ data: { audio_url: '/path' } });
      expect(isFallbackResponse(result)).toBe(false);
    });

    it('should return fallback when operation throws', async () => {
      const result = await runWithTTSCircuitBreaker(async () => {
        throw new Error('TTS timeout');
      });
      expect(isFallbackResponse(result)).toBe(true);
      if (isFallbackResponse(result)) {
        expect(result.text).toBe(FALLBACK_MESSAGE);
        expect(result.fallbackReason).toBe('circuit_open');
      }
    });
  });
});
