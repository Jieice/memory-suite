/**
 * Circuit breaker for critical services (LLM, TTS).
 * Prevents cascading failures when dependencies are down.
 * Use with FallbackManager: breaker opens → return fallback immediately.
 */

import CircuitBreaker from 'opossum';
import { createFallbackResponse, FallbackResponse } from './FallbackTemplate';
import { TIMEOUT_CONFIG } from './FallbackManager';

const LLM_TIMEOUT = TIMEOUT_CONFIG.LLM ?? 5000;
const TTS_TIMEOUT = TIMEOUT_CONFIG.TTS ?? 8000;

const BREAKER_OPTIONS = {
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
};

type AsyncOp<T> = () => Promise<T>;

function makeBreaker<T>(timeoutMs: number): CircuitBreaker<[AsyncOp<T>], T | FallbackResponse> {
  const action = (op: AsyncOp<T>) => op();
  const breaker = new CircuitBreaker(action, {
    timeout: timeoutMs,
    ...BREAKER_OPTIONS,
  });
  breaker.fallback(() => createFallbackResponse('circuit_open') as T | FallbackResponse);
  return breaker as CircuitBreaker<[AsyncOp<T>], T | FallbackResponse>;
}

const llmBreaker = makeBreaker<unknown>(LLM_TIMEOUT);
const ttsBreaker = makeBreaker<unknown>(TTS_TIMEOUT);

/**
 * Run an async operation through the LLM circuit breaker.
 * On circuit open or repeated failures, returns standard fallback response.
 */
export async function runWithLLMCircuitBreaker<T>(
  operation: () => Promise<T>
): Promise<T | FallbackResponse> {
  return llmBreaker.fire(operation) as Promise<T | FallbackResponse>;
}

/**
 * Run an async operation through the TTS circuit breaker.
 * On circuit open or repeated failures, returns standard fallback response.
 */
export async function runWithTTSCircuitBreaker<T>(
  operation: () => Promise<T>
): Promise<T | FallbackResponse> {
  return ttsBreaker.fire(operation) as Promise<T | FallbackResponse>;
}
