/**
 * Error categorization for graceful degradation
 * Determines whether to return fallback message or continue with degraded logic
 */

/**
 * Error categories for different service failures
 */
export enum ErrorCategory {
  // Critical - Return fallback message to user
  LLM_UNAVAILABLE = 'LLM_UNAVAILABLE',
  TTS_UNAVAILABLE = 'TTS_UNAVAILABLE',

  // Non-critical - Skip service, continue
  BRAINNN_UNAVAILABLE = 'BRAINNN_UNAVAILABLE',
  PREDICTION_ENGINE_UNAVAILABLE = 'PREDICTION_ENGINE_UNAVAILABLE',
  MEMORY_SYSTEM_UNAVAILABLE = 'MEMORY_SYSTEM_UNAVAILABLE',
  AGENT_CORE_UNAVAILABLE = 'AGENT_CORE_UNAVAILABLE',
  NEURO_SYMBOLIC_UNAVAILABLE = 'NEURO_SYMBOLIC_UNAVAILABLE',
  REFLECTION_ENGINE_UNAVAILABLE = 'REFLECTION_ENGINE_UNAVAILABLE',

  // Timeout
  SERVICE_TIMEOUT = 'SERVICE_TIMEOUT',

  // Network
  CONNECTION_REFUSED = 'CONNECTION_REFUSED',
  DNS_RESOLUTION_FAILED = 'DNS_RESOLUTION_FAILED',
  NETWORK_ERROR = 'NETWORK_ERROR',

  // Other
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * Severity levels for errors
 */
export enum ErrorSeverity {
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
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
export function isCriticalError(category: ErrorCategory): boolean {
  return (
    category === ErrorCategory.LLM_UNAVAILABLE ||
    category === ErrorCategory.TTS_UNAVAILABLE
  );
}

/**
 * Determine if an error category is non-critical (should continue with degradation)
 */
export function isNonCriticalError(category: ErrorCategory): boolean {
  return (
    category === ErrorCategory.BRAINNN_UNAVAILABLE ||
    category === ErrorCategory.PREDICTION_ENGINE_UNAVAILABLE ||
    category === ErrorCategory.MEMORY_SYSTEM_UNAVAILABLE ||
    category === ErrorCategory.AGENT_CORE_UNAVAILABLE ||
    category === ErrorCategory.NEURO_SYMBOLIC_UNAVAILABLE ||
    category === ErrorCategory.REFLECTION_ENGINE_UNAVAILABLE
  );
}

/**
 * Categorize an error based on service name and error details
 */
export function categorizeError(
  serviceName: string,
  error: Error
): ErrorCategory {
  const errorMessage = error.message.toLowerCase();

  // Check for timeout
  if (
    errorMessage.includes('timeout') ||
    errorMessage.includes('timed out') ||
    errorMessage.includes('econnaborted')
  ) {
    return ErrorCategory.SERVICE_TIMEOUT;
  }

  // Check for connection errors
  if (
    errorMessage.includes('econnrefused') ||
    errorMessage.includes('connection refused')
  ) {
    return ErrorCategory.CONNECTION_REFUSED;
  }

  if (
    errorMessage.includes('enotfound') ||
    errorMessage.includes('dns') ||
    errorMessage.includes('getaddrinfo')
  ) {
    return ErrorCategory.DNS_RESOLUTION_FAILED;
  }

  if (
    errorMessage.includes('econnreset') ||
    errorMessage.includes('socket hang up') ||
    errorMessage.includes('network')
  ) {
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
export function getSeverity(category: ErrorCategory): ErrorSeverity {
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
export function createErrorContext(
  serviceName: string,
  error: Error,
  details?: Record<string, any>
): ErrorContext {
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
