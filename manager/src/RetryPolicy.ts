/**
 * RetryPolicy for ServiceOrchestrator
 * 
 * Implements exponential backoff with jitter for retrying failed requests
 * 
 * Requirements: 8.1, 8.2, 8.4
 */

// ============================================
// Types
// ============================================

export interface RetryPolicyConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Initial delay in milliseconds */
  initialDelayMs: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
  /** Jitter factor (0-1) to add randomness to delays */
  jitterFactor: number;
  /** Function to determine if an error should be retried */
  shouldRetry: (error: Error, attempt: number) => boolean;
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  totalDelayMs: number;
}

export interface RetryAttempt {
  attempt: number;
  error: Error;
  delayMs: number;
  timestamp: Date;
}

// ============================================
// RetryPolicy Class
// ============================================

export class RetryPolicy {
  private config: RetryPolicyConfig;
  private lastAttempts: RetryAttempt[] = [];

  constructor(config: Partial<RetryPolicyConfig> = {}) {
    this.config = {
      maxRetries: config.maxRetries ?? 3,
      initialDelayMs: config.initialDelayMs ?? 1000,
      maxDelayMs: config.maxDelayMs ?? 10000,
      backoffMultiplier: config.backoffMultiplier ?? 2,
      jitterFactor: config.jitterFactor ?? 0.3,
      shouldRetry: config.shouldRetry ?? defaultShouldRetry
    };
  }

  /**
   * Execute a function with retry logic
   */
  async execute<T>(fn: () => Promise<T>): Promise<RetryResult<T>> {
    this.lastAttempts = [];
    let lastError: Error | null = null;
    let delay = this.config.initialDelayMs;
    let totalDelayMs = 0;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const result = await fn();
        return {
          success: true,
          result,
          attempts: attempt + 1,
          totalDelayMs
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Record the attempt
        this.lastAttempts.push({
          attempt: attempt + 1,
          error: lastError,
          delayMs: attempt < this.config.maxRetries ? delay : 0,
          timestamp: new Date()
        });

        // Check if we should retry this error
        if (!this.config.shouldRetry(lastError, attempt)) {
          return {
            success: false,
            error: lastError,
            attempts: attempt + 1,
            totalDelayMs
          };
        }

        // If this was the last attempt, don't wait
        if (attempt === this.config.maxRetries) {
          break;
        }

        // Calculate delay with jitter
        const jitter = this.calculateJitter(delay);
        const actualDelay = Math.min(delay + jitter, this.config.maxDelayMs);
        
        // Wait before retrying
        await this.sleep(actualDelay);
        totalDelayMs += actualDelay;

        // Calculate next delay with exponential backoff
        delay = Math.min(
          delay * this.config.backoffMultiplier,
          this.config.maxDelayMs
        );
      }
    }

    return {
      success: false,
      error: lastError || new Error('Unknown error in retry loop'),
      attempts: this.config.maxRetries + 1,
      totalDelayMs
    };
  }

  /**
   * Execute with automatic throw on failure
   */
  async executeOrThrow<T>(fn: () => Promise<T>): Promise<T> {
    const result = await this.execute(fn);
    if (!result.success) {
      throw result.error;
    }
    return result.result!;
  }

  /**
   * Calculate jitter for a given delay
   */
  private calculateJitter(delay: number): number {
    // Add random jitter between -jitterFactor and +jitterFactor of the delay
    const jitterRange = delay * this.config.jitterFactor;
    return (Math.random() * 2 - 1) * jitterRange;
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get the last retry attempts
   */
  getLastAttempts(): RetryAttempt[] {
    return [...this.lastAttempts];
  }

  /**
   * Get configuration
   */
  getConfig(): RetryPolicyConfig {
    return { ...this.config };
  }

  /**
   * Calculate the expected delay for a given attempt number
   */
  calculateDelayForAttempt(attempt: number): number {
    let delay = this.config.initialDelayMs;
    for (let i = 0; i < attempt; i++) {
      delay = Math.min(delay * this.config.backoffMultiplier, this.config.maxDelayMs);
    }
    return delay;
  }

  /**
   * Calculate the maximum total delay for all retries
   */
  calculateMaxTotalDelay(): number {
    let total = 0;
    let delay = this.config.initialDelayMs;
    for (let i = 0; i < this.config.maxRetries; i++) {
      total += Math.min(delay, this.config.maxDelayMs);
      delay *= this.config.backoffMultiplier;
    }
    return total;
  }
}

// ============================================
// Default shouldRetry Function
// ============================================

function defaultShouldRetry(error: Error, attempt: number): boolean {
  const message = error.message.toLowerCase();
  
  // Retry on transient errors
  return (
    message.includes('timeout') ||
    message.includes('rate limit') ||
    message.includes('temporarily unavailable') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('network') ||
    message.includes('503') ||
    message.includes('502') ||
    message.includes('504') ||
    message.includes('429')
  );
}

// ============================================
// Preset Configurations
// ============================================

export const DEFAULT_RETRY_CONFIG: Partial<RetryPolicyConfig> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  jitterFactor: 0.3
};

export const AGGRESSIVE_RETRY_CONFIG: Partial<RetryPolicyConfig> = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 3000,
  backoffMultiplier: 2,
  jitterFactor: 0.2
};

export const LENIENT_RETRY_CONFIG: Partial<RetryPolicyConfig> = {
  maxRetries: 5,
  initialDelayMs: 2000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterFactor: 0.4
};

export const NO_RETRY_CONFIG: Partial<RetryPolicyConfig> = {
  maxRetries: 0,
  initialDelayMs: 0,
  maxDelayMs: 0,
  backoffMultiplier: 1,
  jitterFactor: 0,
  shouldRetry: () => false
};

// ============================================
// Utility Functions
// ============================================

/**
 * Create a shouldRetry function that only retries specific error codes
 */
export function createErrorCodeRetryFilter(codes: string[]): (error: Error) => boolean {
  return (error: Error) => {
    const message = error.message.toLowerCase();
    return codes.some(code => message.includes(code.toLowerCase()));
  };
}

/**
 * Create a shouldRetry function with a maximum attempt limit
 */
export function createMaxAttemptRetryFilter(
  maxAttempts: number,
  baseShouldRetry: (error: Error, attempt: number) => boolean = defaultShouldRetry
): (error: Error, attempt: number) => boolean {
  return (error: Error, attempt: number) => {
    if (attempt >= maxAttempts) {
      return false;
    }
    return baseShouldRetry(error, attempt);
  };
}
