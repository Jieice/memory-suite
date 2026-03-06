/**
 * CircuitBreaker for ServiceOrchestrator
 * 
 * Prevents cascading failures by stopping requests to failing services
 * Implements state machine: CLOSED → OPEN → HALF_OPEN → CLOSED
 * 
 * Requirements: 8.1, 8.2, 8.4
 */

// ============================================
// Types
// ============================================

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Number of successes in HALF_OPEN state before closing */
  successThreshold: number;
  /** Time in ms before attempting to close an open circuit */
  timeout: number;
  /** Name for logging purposes */
  name?: string;
}

export interface CircuitBreakerStats {
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
}

// ============================================
// CircuitBreaker Class
// ============================================

export class CircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private totalRequests: number = 0;
  private totalFailures: number = 0;
  private totalSuccesses: number = 0;
  private config: Required<CircuitBreakerConfig>;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      successThreshold: config.successThreshold ?? 2,
      timeout: config.timeout ?? 30000, // 30 seconds
      name: config.name ?? 'default'
    };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalRequests++;
    
    // Check if we should transition from OPEN to HALF_OPEN
    if (this.state === 'OPEN') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure >= this.config.timeout) {
        this.transitionTo('HALF_OPEN');
      } else {
        const waitTime = this.config.timeout - timeSinceLastFailure;
        throw new CircuitBreakerOpenError(
          `Circuit breaker [${this.config.name}] is OPEN. Retry after ${waitTime}ms`,
          waitTime
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    this.totalSuccesses++;
    this.failureCount = 0;

    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.transitionTo('CLOSED');
      }
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(): void {
    this.totalFailures++;
    this.lastFailureTime = Date.now();
    this.failureCount++;
    this.successCount = 0;

    if (this.state === 'HALF_OPEN') {
      // Any failure in HALF_OPEN immediately opens the circuit
      this.transitionTo('OPEN');
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.transitionTo('OPEN');
    }
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitBreakerState): void {
    const oldState = this.state;
    this.state = newState;
    
    if (newState === 'CLOSED') {
      this.failureCount = 0;
      this.successCount = 0;
    } else if (newState === 'HALF_OPEN') {
      this.successCount = 0;
    }
    
    console.log(`[CircuitBreaker:${this.config.name}] State transition: ${oldState} → ${newState}`);
  }

  /**
   * Get current circuit breaker state
   */
  getState(): CircuitBreakerState {
    // Check if we should auto-transition from OPEN to HALF_OPEN
    if (this.state === 'OPEN') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure >= this.config.timeout) {
        return 'HALF_OPEN';
      }
    }
    return this.state;
  }

  /**
   * Get circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses
    };
  }

  /**
   * Reset circuit breaker to initial state
   */
  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    console.log(`[CircuitBreaker:${this.config.name}] Reset to CLOSED state`);
  }

  /**
   * Check if circuit breaker allows requests
   */
  isAllowed(): boolean {
    const currentState = this.getState();
    return currentState === 'CLOSED' || currentState === 'HALF_OPEN';
  }

  /**
   * Get time until circuit breaker might allow requests (if OPEN)
   */
  getTimeUntilRetry(): number {
    if (this.state !== 'OPEN') {
      return 0;
    }
    const timeSinceLastFailure = Date.now() - this.lastFailureTime;
    return Math.max(0, this.config.timeout - timeSinceLastFailure);
  }

  /**
   * Get configuration
   */
  getConfig(): Required<CircuitBreakerConfig> {
    return { ...this.config };
  }
}

// ============================================
// Custom Error
// ============================================

export class CircuitBreakerOpenError extends Error {
  public readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

// ============================================
// Preset Configurations
// ============================================

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 30000 // 30 seconds
};

export const AGGRESSIVE_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  successThreshold: 1,
  timeout: 15000 // 15 seconds
};

export const LENIENT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 10,
  successThreshold: 3,
  timeout: 60000 // 60 seconds
};
