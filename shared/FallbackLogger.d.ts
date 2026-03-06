/**
 * Structured logging for fallback events
 * Tracks all fallback occurrences for monitoring and debugging
 */
import { ErrorContext, ErrorCategory, ErrorSeverity } from './ErrorCategories';
/**
 * Fallback event for logging
 */
export interface FallbackEvent {
    timestamp: number;
    serviceName: string;
    category: ErrorCategory;
    severity: ErrorSeverity;
    reason: string;
    error?: string;
    details?: Record<string, any>;
}
/**
 * Fallback statistics
 */
export interface FallbackStatistics {
    totalFallbacks: number;
    fallbacksByService: Record<string, number>;
    fallbacksByCategory: Record<string, number>;
    fallbacksBySeverity: Record<string, number>;
    lastFallbackTime: number;
    firstFallbackTime: number;
}
/**
 * Fallback Logger - Centralized logging for all fallback events
 */
export declare class FallbackLogger {
    private logFile;
    private events;
    private statistics;
    constructor(logDir?: string);
    /**
     * Log a fallback event
     */
    logFallback(serviceName: string, category: ErrorCategory, severity: ErrorSeverity, reason: string, error?: Error, details?: Record<string, any>): void;
    /**
     * Log from error context
     */
    logFromContext(context: ErrorContext, reason: string): void;
    /**
     * Update statistics
     */
    private updateStatistics;
    /**
     * Write event to log file
     */
    private writeToFile;
    /**
     * Log to console based on severity
     */
    private logToConsole;
    /**
     * Get all logged events
     */
    getEvents(): FallbackEvent[];
    /**
     * Get statistics
     */
    getStatistics(): FallbackStatistics;
    /**
     * Get log count
     */
    getLogCount(): number;
    /**
     * Get events for a specific service
     */
    getEventsByService(serviceName: string): FallbackEvent[];
    /**
     * Get events for a specific category
     */
    getEventsByCategory(category: ErrorCategory): FallbackEvent[];
    /**
     * Get events for a specific severity
     */
    getEventsBySeverity(severity: ErrorSeverity): FallbackEvent[];
    /**
     * Get events within a time range
     */
    getEventsByTimeRange(startTime: number, endTime: number): FallbackEvent[];
    /**
     * Clear events (for testing)
     */
    clear(): void;
    /**
     * Export statistics as Prometheus metrics
     */
    exportPrometheusMetrics(): string;
}
/**
 * Get or create global logger instance
 */
export declare function getGlobalLogger(logDir?: string): FallbackLogger;
/**
 * Reset global logger (for testing)
 */
export declare function resetGlobalLogger(): void;
