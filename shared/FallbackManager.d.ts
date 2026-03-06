/**
 * Centralized Fallback Manager
 * Handles all fallback logic, timeouts, retries, and service health checks
 */
import { FallbackResponse } from './FallbackTemplate';
import { FallbackLogger, FallbackStatistics } from './FallbackLogger';
/**
 * Timeout configuration for different services
 */
export declare const TIMEOUT_CONFIG: Record<string, number>;
/**
 * Retry configuration for critical services
 */
export interface RetryConfig {
    maxRetries: number;
    backoffMultiplier: number;
    initialDelay: number;
}
export declare const RETRY_CONFIG: Record<string, RetryConfig>;
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
export declare class FallbackManager {
    private logger;
    private serviceHealthCache;
    private healthCheckTimeout;
    constructor(logger?: FallbackLogger);
    /**
     * Execute an operation with fallback handling
     * For critical services: returns fallback response on failure
     * For non-critical services: returns fallback value on failure
     */
    executeWithFallback<T>(serviceName: string, operation: () => Promise<T>, fallbackValue: T, timeout?: number): Promise<T>;
    /**
     * Execute with timeout
     */
    private executeWithTimeout;
    /**
     * Execute with retry logic
     */
    private executeWithRetry;
    /**
     * Create a timeout promise
     */
    private createTimeoutPromise;
    /**
     * Sleep utility
     */
    private sleep;
    /**
     * Get fallback response for a service
     */
    getFallbackResponse(reason: string, error?: Error): FallbackResponse;
    /**
     * Check if a service is available
     */
    isServiceAvailable(serviceName: string, url: string): Promise<boolean>;
    /**
     * Get service health status
     */
    getServiceHealth(serviceName: string, url: string): Promise<ServiceHealth>;
    /**
     * Get all service health statuses
     */
    getAllServiceHealth(services: Array<{
        name: string;
        url: string;
    }>): Promise<ServiceHealth[]>;
    /**
     * Get fallback statistics
     */
    getStatistics(): FallbackStatistics;
    /**
     * Clear cache (for testing)
     */
    clearCache(): void;
    /**
     * Export Prometheus metrics
     */
    exportPrometheusMetrics(): string;
}
/**
 * Get or create global manager instance
 */
export declare function getGlobalFallbackManager(logger?: FallbackLogger): FallbackManager;
/**
 * Reset global manager (for testing)
 */
export declare function resetGlobalFallbackManager(): void;
