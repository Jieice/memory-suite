/**
 * Centralized Fallback Manager
 * Handles all fallback logic, timeouts, retries, and service health checks
 */

import {
  ErrorCategory,
  ErrorSeverity,
  categorizeError,
  createErrorContext,
  isCriticalError,
} from './ErrorCategories';
import {
  FALLBACK_MESSAGE,
  FallbackResponse,
  createFallbackResponse,
} from './FallbackTemplate';
import {
  FallbackLogger,
  getGlobalLogger,
  FallbackStatistics,
} from './FallbackLogger';

/**
 * Timeout configuration for different services
 */
export const TIMEOUT_CONFIG: Record<string, number> = {
  LLM: 5000, // 5s - Critical (reduced from 15s for live streaming)
  TTS: 8000, // 8s - Critical
  BRAINNN: 3000, // 3s - Non-critical
  AGENT_CORE: 2000, // 2s - Non-critical
  MEMORY_SYSTEM: 2000, // 2s - Non-critical
  PREDICTION_ENGINE: 2000, // 2s - Non-critical
  NEURO_SYMBOLIC: 2000, // 2s - Non-critical
  REFLECTION_ENGINE: 2000, // 2s - Non-critical
};

/**
 * Retry configuration for critical services
 */
export interface RetryConfig {
  maxRetries: number;
  backoffMultiplier: number;
  initialDelay: number;
}

export const RETRY_CONFIG: Record<string, RetryConfig> = {
  LLM: {
    maxRetries: 2,
    backoffMultiplier: 2,
    initialDelay: 500,
  },
  TTS: {
    maxRetries: 2,
    backoffMultiplier: 2,
    initialDelay: 500,
  },
  // Non-critical services: no retry
};

/**
 * Service health status
 */
export interface ServiceHealth {
  serviceName: string;
  isAvailable: boolean;
  lastCheckTime: number;
  lastError?: string;
}

/**
 * Fallback Manager - Centralized fallback handling
 */
export class FallbackManager {
  private logger: FallbackLogger;
  private serviceHealthCache: Map<string, ServiceHealth> = new Map();
  private healthCheckTimeout: number = 2000; // 2s for health checks

  constructor(logger?: FallbackLogger) {
    this.logger = logger || getGlobalLogger();
  }

  /**
   * Execute an operation with fallback handling
   * For critical services: returns fallback response on failure
   * For non-critical services: returns fallback value on failure
   */
  async executeWithFallback<T>(
    serviceName: string,
    operation: () => Promise<T>,
    fallbackValue: T,
    timeout?: number
  ): Promise<T> {
    const timeoutMs = timeout || (Object.prototype.hasOwnProperty.call(TIMEOUT_CONFIG, serviceName) ? TIMEOUT_CONFIG[serviceName] : 5000);
    const retryConfig = Object.prototype.hasOwnProperty.call(RETRY_CONFIG, serviceName) ? RETRY_CONFIG[serviceName] : undefined;

    // Try with retries for critical services
    if (retryConfig) {
      return this.executeWithRetry(
        serviceName,
        operation,
        fallbackValue,
        timeoutMs,
        retryConfig
      );
    }

    // Single attempt for non-critical services
    return this.executeWithTimeout(
      serviceName,
      operation,
      fallbackValue,
      timeoutMs
    );
  }

  /**
   * Execute with timeout
   */
  private async executeWithTimeout<T>(
    serviceName: string,
    operation: () => Promise<T>,
    fallbackValue: T,
    timeoutMs: number
  ): Promise<T> {
    try {
      return await Promise.race([
        operation(),
        this.createTimeoutPromise<T>(timeoutMs),
      ]);
    } catch (error) {
      const err = error as Error;
      const context = createErrorContext(serviceName, err);

      this.logger.logFromContext(context, `Operation failed: ${err.message}`);

      return fallbackValue;
    }
  }

  /**
   * Execute with retry logic
   */
  private async executeWithRetry<T>(
    serviceName: string,
    operation: () => Promise<T>,
    fallbackValue: T,
    timeoutMs: number,
    retryConfig: RetryConfig
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
      try {
        return await Promise.race([
          operation(),
          this.createTimeoutPromise<T>(timeoutMs),
        ]);
      } catch (error) {
        lastError = error as Error;

        // If this is the last attempt, log and return fallback
        if (attempt === retryConfig.maxRetries) {
          const context = createErrorContext(serviceName, lastError);
          this.logger.logFromContext(
            context,
            `Operation failed after ${retryConfig.maxRetries + 1} attempts`
          );
          return fallbackValue;
        }

        // Wait before retry with exponential backoff
        const delay =
          retryConfig.initialDelay *
          Math.pow(retryConfig.backoffMultiplier, attempt);
        await this.sleep(delay);
      }
    }

    return fallbackValue;
  }

  /**
   * Create a timeout promise
   */
  private createTimeoutPromise<T>(timeoutMs: number): Promise<T> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Operation timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get fallback response for a service
   */
  getFallbackResponse(reason: string, error?: Error): FallbackResponse {
    return createFallbackResponse(reason, error);
  }

  /**
   * Check if a service is available
   */
  async isServiceAvailable(
    serviceName: string,
    url: string
  ): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.healthCheckTimeout);
    try {
      const response = await fetch(`${url}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      return response.ok;
    } catch (error) {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get service health status
   */
  async getServiceHealth(
    serviceName: string,
    url: string
  ): Promise<ServiceHealth> {
    // Check cache first
    const cached = this.serviceHealthCache.get(serviceName);
    if (cached && Date.now() - cached.lastCheckTime < 30000) {
      // Cache for 30 seconds
      return cached;
    }

    // Perform health check
    try {
      const isAvailable = await this.isServiceAvailable(serviceName, url);
      const health: ServiceHealth = {
        serviceName,
        isAvailable,
        lastCheckTime: Date.now(),
      };

      this.serviceHealthCache.set(serviceName, health);
      return health;
    } catch (error) {
      const health: ServiceHealth = {
        serviceName,
        isAvailable: false,
        lastCheckTime: Date.now(),
        lastError: (error as Error).message,
      };

      this.serviceHealthCache.set(serviceName, health);
      return health;
    }
  }

  /**
   * Get all service health statuses
   */
  async getAllServiceHealth(
    services: Array<{ name: string; url: string }>
  ): Promise<ServiceHealth[]> {
    const healthChecks = services.map((service) =>
      this.getServiceHealth(service.name, service.url)
    );

    return Promise.all(healthChecks);
  }

  /**
   * Get fallback statistics
   */
  getStatistics(): FallbackStatistics {
    return this.logger.getStatistics();
  }

  /**
   * Clear cache (for testing)
   */
  clearCache(): void {
    this.serviceHealthCache.clear();
  }

  /**
   * Export Prometheus metrics
   */
  exportPrometheusMetrics(): string {
    return this.logger.exportPrometheusMetrics();
  }
}

// Global manager instance
let globalManager: FallbackManager | null = null;

/**
 * Get or create global manager instance
 */
export function getGlobalFallbackManager(
  logger?: FallbackLogger
): FallbackManager {
  if (!globalManager) {
    globalManager = new FallbackManager(logger);
  }
  return globalManager;
}

/**
 * Reset global manager (for testing)
 */
export function resetGlobalFallbackManager(): void {
  globalManager = null;
}
