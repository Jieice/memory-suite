/**
 * Error categorization for graceful degradation
 * Determines whether to return fallback message or continue with degraded logic
 */
/**
 * Error categories for different service failures
 */
export declare enum ErrorCategory {
    LLM_UNAVAILABLE = "LLM_UNAVAILABLE",
    TTS_UNAVAILABLE = "TTS_UNAVAILABLE",
    BRAINNN_UNAVAILABLE = "BRAINNN_UNAVAILABLE",
    PREDICTION_ENGINE_UNAVAILABLE = "PREDICTION_ENGINE_UNAVAILABLE",
    MEMORY_SYSTEM_UNAVAILABLE = "MEMORY_SYSTEM_UNAVAILABLE",
    AGENT_CORE_UNAVAILABLE = "AGENT_CORE_UNAVAILABLE",
    NEURO_SYMBOLIC_UNAVAILABLE = "NEURO_SYMBOLIC_UNAVAILABLE",
    REFLECTION_ENGINE_UNAVAILABLE = "REFLECTION_ENGINE_UNAVAILABLE",
    SERVICE_TIMEOUT = "SERVICE_TIMEOUT",
    CONNECTION_REFUSED = "CONNECTION_REFUSED",
    DNS_RESOLUTION_FAILED = "DNS_RESOLUTION_FAILED",
    NETWORK_ERROR = "NETWORK_ERROR",
    UNKNOWN_ERROR = "UNKNOWN_ERROR"
}
/**
 * Severity levels for errors
 */
export declare enum ErrorSeverity {
    WARNING = "warning",
    ERROR = "error",
    CRITICAL = "critical"
}
/**
 * Context information for an error
 */
export interface ErrorContext {
    category: ErrorCategory;
    serviceName: string;
    originalError: Error;
    timestamp: number;
    severity: ErrorSeverity;
    details?: Record<string, any>;
}
/**
 * Determine if an error category is critical (should return fallback message)
 */
export declare function isCriticalError(category: ErrorCategory): boolean;
/**
 * Determine if an error category is non-critical (should continue with degradation)
 */
export declare function isNonCriticalError(category: ErrorCategory): boolean;
/**
 * Categorize an error based on service name and error details
 */
export declare function categorizeError(serviceName: string, error: Error): ErrorCategory;
/**
 * Determine severity based on error category
 */
export declare function getSeverity(category: ErrorCategory): ErrorSeverity;
/**
 * Create an error context
 */
export declare function createErrorContext(serviceName: string, error: Error, details?: Record<string, any>): ErrorContext;
