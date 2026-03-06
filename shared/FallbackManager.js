"use strict";
/**
 * Centralized Fallback Manager
 * Handles all fallback logic, timeouts, retries, and service health checks
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FallbackManager = exports.RETRY_CONFIG = exports.TIMEOUT_CONFIG = void 0;
exports.getGlobalFallbackManager = getGlobalFallbackManager;
exports.resetGlobalFallbackManager = resetGlobalFallbackManager;
const ErrorCategories_1 = require("./ErrorCategories");
const FallbackTemplate_1 = require("./FallbackTemplate");
const FallbackLogger_1 = require("./FallbackLogger");
/**
 * Timeout configuration for different services
 */
exports.TIMEOUT_CONFIG = {
    LLM: 15000, // 15s - Critical
    TTS: 10000, // 10s - Critical
    BRAINNN: 3000, // 3s - Non-critical
    AGENT_CORE: 2000, // 2s - Non-critical
    MEMORY_SYSTEM: 2000, // 2s - Non-critical
    PREDICTION_ENGINE: 2000, // 2s - Non-critical
    NEURO_SYMBOLIC: 2000, // 2s - Non-critical
    REFLECTION_ENGINE: 2000, // 2s - Non-critical
};
exports.RETRY_CONFIG = {
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
 * Fallback Manager - Centralized fallback handling
 */
class FallbackManager {
    logger;
    serviceHealthCache = new Map();
    healthCheckTimeout = 2000; // 2s for health checks
    constructor(logger) {
        this.logger = logger || (0, FallbackLogger_1.getGlobalLogger)();
    }
    /**
     * Execute an operation with fallback handling
     * For critical services: returns fallback response on failure
     * For non-critical services: returns fallback value on failure
     */
    async executeWithFallback(serviceName, operation, fallbackValue, timeout) {
        const timeoutMs = timeout || exports.TIMEOUT_CONFIG[serviceName] || 5000;
        const retryConfig = exports.RETRY_CONFIG[serviceName];
        // Try with retries for critical services
        if (retryConfig) {
            return this.executeWithRetry(serviceName, operation, fallbackValue, timeoutMs, retryConfig);
        }
        // Single attempt for non-critical services
        return this.executeWithTimeout(serviceName, operation, fallbackValue, timeoutMs);
    }
    /**
     * Execute with timeout
     */
    async executeWithTimeout(serviceName, operation, fallbackValue, timeoutMs) {
        try {
            return await Promise.race([
                operation(),
                this.createTimeoutPromise(timeoutMs),
            ]);
        }
        catch (error) {
            const err = error;
            const context = (0, ErrorCategories_1.createErrorContext)(serviceName, err);
            this.logger.logFromContext(context, `Operation failed: ${err.message}`);
            return fallbackValue;
        }
    }
    /**
     * Execute with retry logic
     */
    async executeWithRetry(serviceName, operation, fallbackValue, timeoutMs, retryConfig) {
        let lastError = null;
        for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
            try {
                return await Promise.race([
                    operation(),
                    this.createTimeoutPromise(timeoutMs),
                ]);
            }
            catch (error) {
                lastError = error;
                // If this is the last attempt, log and return fallback
                if (attempt === retryConfig.maxRetries) {
                    const context = (0, ErrorCategories_1.createErrorContext)(serviceName, lastError);
                    this.logger.logFromContext(context, `Operation failed after ${retryConfig.maxRetries + 1} attempts`);
                    return fallbackValue;
                }
                // Wait before retry with exponential backoff
                const delay = retryConfig.initialDelay *
                    Math.pow(retryConfig.backoffMultiplier, attempt);
                await this.sleep(delay);
            }
        }
        return fallbackValue;
    }
    /**
     * Create a timeout promise
     */
    createTimeoutPromise(timeoutMs) {
        return new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Operation timeout after ${timeoutMs}ms`));
            }, timeoutMs);
        });
    }
    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /**
     * Get fallback response for a service
     */
    getFallbackResponse(reason, error) {
        return (0, FallbackTemplate_1.createFallbackResponse)(reason, error);
    }
    /**
     * Check if a service is available
     */
    async isServiceAvailable(serviceName, url) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.healthCheckTimeout);
        try {
            const response = await fetch(`${url}/health`, {
                method: 'GET',
                signal: controller.signal,
            });
            return response.ok;
        }
        catch (error) {
            return false;
        }
        finally {
            clearTimeout(timeoutId);
        }
    }
    /**
     * Get service health status
     */
    async getServiceHealth(serviceName, url) {
        // Check cache first
        const cached = this.serviceHealthCache.get(serviceName);
        if (cached && Date.now() - cached.lastCheckTime < 30000) {
            // Cache for 30 seconds
            return cached;
        }
        // Perform health check
        try {
            const isAvailable = await this.isServiceAvailable(serviceName, url);
            const health = {
                serviceName,
                isAvailable,
                lastCheckTime: Date.now(),
            };
            this.serviceHealthCache.set(serviceName, health);
            return health;
        }
        catch (error) {
            const health = {
                serviceName,
                isAvailable: false,
                lastCheckTime: Date.now(),
                lastError: error.message,
            };
            this.serviceHealthCache.set(serviceName, health);
            return health;
        }
    }
    /**
     * Get all service health statuses
     */
    async getAllServiceHealth(services) {
        const healthChecks = services.map((service) => this.getServiceHealth(service.name, service.url));
        return Promise.all(healthChecks);
    }
    /**
     * Get fallback statistics
     */
    getStatistics() {
        return this.logger.getStatistics();
    }
    /**
     * Clear cache (for testing)
     */
    clearCache() {
        this.serviceHealthCache.clear();
    }
    /**
     * Export Prometheus metrics
     */
    exportPrometheusMetrics() {
        return this.logger.exportPrometheusMetrics();
    }
}
exports.FallbackManager = FallbackManager;
// Global manager instance
let globalManager = null;
/**
 * Get or create global manager instance
 */
function getGlobalFallbackManager(logger) {
    if (!globalManager) {
        globalManager = new FallbackManager(logger);
    }
    return globalManager;
}
/**
 * Reset global manager (for testing)
 */
function resetGlobalFallbackManager() {
    globalManager = null;
}
//# sourceMappingURL=FallbackManager.js.map
