"use strict";
/**
 * Error categorization for graceful degradation
 * Determines whether to return fallback message or continue with degraded logic
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorSeverity = exports.ErrorCategory = void 0;
exports.isCriticalError = isCriticalError;
exports.isNonCriticalError = isNonCriticalError;
exports.categorizeError = categorizeError;
exports.getSeverity = getSeverity;
exports.createErrorContext = createErrorContext;
/**
 * Error categories for different service failures
 */
var ErrorCategory;
(function (ErrorCategory) {
    // Critical - Return fallback message to user
    ErrorCategory["LLM_UNAVAILABLE"] = "LLM_UNAVAILABLE";
    ErrorCategory["TTS_UNAVAILABLE"] = "TTS_UNAVAILABLE";
    // Non-critical - Skip service, continue
    ErrorCategory["BRAINNN_UNAVAILABLE"] = "BRAINNN_UNAVAILABLE";
    ErrorCategory["PREDICTION_ENGINE_UNAVAILABLE"] = "PREDICTION_ENGINE_UNAVAILABLE";
    ErrorCategory["MEMORY_SYSTEM_UNAVAILABLE"] = "MEMORY_SYSTEM_UNAVAILABLE";
    ErrorCategory["AGENT_CORE_UNAVAILABLE"] = "AGENT_CORE_UNAVAILABLE";
    ErrorCategory["NEURO_SYMBOLIC_UNAVAILABLE"] = "NEURO_SYMBOLIC_UNAVAILABLE";
    ErrorCategory["REFLECTION_ENGINE_UNAVAILABLE"] = "REFLECTION_ENGINE_UNAVAILABLE";
    // Timeout
    ErrorCategory["SERVICE_TIMEOUT"] = "SERVICE_TIMEOUT";
    // Network
    ErrorCategory["CONNECTION_REFUSED"] = "CONNECTION_REFUSED";
    ErrorCategory["DNS_RESOLUTION_FAILED"] = "DNS_RESOLUTION_FAILED";
    ErrorCategory["NETWORK_ERROR"] = "NETWORK_ERROR";
    // Other
    ErrorCategory["UNKNOWN_ERROR"] = "UNKNOWN_ERROR";
})(ErrorCategory || (exports.ErrorCategory = ErrorCategory = {}));
/**
 * Severity levels for errors
 */
var ErrorSeverity;
(function (ErrorSeverity) {
    ErrorSeverity["WARNING"] = "warning";
    ErrorSeverity["ERROR"] = "error";
    ErrorSeverity["CRITICAL"] = "critical";
})(ErrorSeverity || (exports.ErrorSeverity = ErrorSeverity = {}));
/**
 * Determine if an error category is critical (should return fallback message)
 */
function isCriticalError(category) {
    return (category === ErrorCategory.LLM_UNAVAILABLE ||
        category === ErrorCategory.TTS_UNAVAILABLE);
}
/**
 * Determine if an error category is non-critical (should continue with degradation)
 */
function isNonCriticalError(category) {
    return (category === ErrorCategory.BRAINNN_UNAVAILABLE ||
        category === ErrorCategory.PREDICTION_ENGINE_UNAVAILABLE ||
        category === ErrorCategory.MEMORY_SYSTEM_UNAVAILABLE ||
        category === ErrorCategory.AGENT_CORE_UNAVAILABLE ||
        category === ErrorCategory.NEURO_SYMBOLIC_UNAVAILABLE ||
        category === ErrorCategory.REFLECTION_ENGINE_UNAVAILABLE);
}
/**
 * Categorize an error based on service name and error details
 */
function categorizeError(serviceName, error) {
    const errorMessage = error.message.toLowerCase();
    // Check for timeout
    if (errorMessage.includes('timeout') ||
        errorMessage.includes('timed out') ||
        errorMessage.includes('econnaborted')) {
        return ErrorCategory.SERVICE_TIMEOUT;
    }
    // Check for connection errors
    if (errorMessage.includes('econnrefused') ||
        errorMessage.includes('connection refused')) {
        return ErrorCategory.CONNECTION_REFUSED;
    }
    if (errorMessage.includes('enotfound') ||
        errorMessage.includes('dns') ||
        errorMessage.includes('getaddrinfo')) {
        return ErrorCategory.DNS_RESOLUTION_FAILED;
    }
    if (errorMessage.includes('econnreset') ||
        errorMessage.includes('socket hang up') ||
        errorMessage.includes('network')) {
        return ErrorCategory.NETWORK_ERROR;
    }
    // Service-specific categorization
    const serviceLower = serviceName.toLowerCase();
    if (serviceLower.includes('llm') || serviceLower.includes('deepseek')) {
        return ErrorCategory.LLM_UNAVAILABLE;
    }
    if (serviceLower.includes('tts')) {
        return ErrorCategory.TTS_UNAVAILABLE;
    }
    if (serviceLower.includes('brainnn')) {
        return ErrorCategory.BRAINNN_UNAVAILABLE;
    }
    if (serviceLower.includes('prediction')) {
        return ErrorCategory.PREDICTION_ENGINE_UNAVAILABLE;
    }
    if (serviceLower.includes('memory')) {
        return ErrorCategory.MEMORY_SYSTEM_UNAVAILABLE;
    }
    if (serviceLower.includes('agent')) {
        return ErrorCategory.AGENT_CORE_UNAVAILABLE;
    }
    if (serviceLower.includes('neuro') || serviceLower.includes('symbolic')) {
        return ErrorCategory.NEURO_SYMBOLIC_UNAVAILABLE;
    }
    if (serviceLower.includes('reflection')) {
        return ErrorCategory.REFLECTION_ENGINE_UNAVAILABLE;
    }
    return ErrorCategory.UNKNOWN_ERROR;
}
/**
 * Determine severity based on error category
 */
function getSeverity(category) {
    if (isCriticalError(category)) {
        return ErrorSeverity.CRITICAL;
    }
    if (isNonCriticalError(category)) {
        return ErrorSeverity.WARNING;
    }
    return ErrorSeverity.ERROR;
}
/**
 * Create an error context
 */
function createErrorContext(serviceName, error, details) {
    const category = categorizeError(serviceName, error);
    const severity = getSeverity(category);
    return {
        category,
        serviceName,
        originalError: error,
        timestamp: Date.now(),
        severity,
        details,
    };
}
//# sourceMappingURL=ErrorCategories.js.map
