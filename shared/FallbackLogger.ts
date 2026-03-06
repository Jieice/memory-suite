/**
 * Structured logging for fallback events
 * Tracks all fallback occurrences for monitoring and debugging
 */

import * as fs from 'fs';
import * as path from 'path';
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
export class FallbackLogger {
  private logFile: string;
  private events: FallbackEvent[] = [];
  private statistics: FallbackStatistics = {
    totalFallbacks: 0,
    fallbacksByService: {},
    fallbacksByCategory: {},
    fallbacksBySeverity: {},
    lastFallbackTime: 0,
    firstFallbackTime: 0,
  };

  constructor(logDir: string = './logs') {
    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Create log file path with timestamp
    const timestamp = new Date().toISOString().split('T')[0];
    this.logFile = path.join(logDir, `fallback-${timestamp}.log`);
  }

  /**
   * Log a fallback event
   */
  logFallback(
    serviceName: string,
    category: ErrorCategory,
    severity: ErrorSeverity,
    reason: string,
    error?: Error,
    details?: Record<string, any>
  ): void {
    const event: FallbackEvent = {
      timestamp: Date.now(),
      serviceName,
      category,
      severity,
      reason,
      error: error?.message,
      details,
    };

    // Add to in-memory events
    this.events.push(event);

    // Update statistics
    this.updateStatistics(event);

    // Write to file
    this.writeToFile(event);

    // Log to console based on severity
    this.logToConsole(event);
  }

  /**
   * Log from error context
   */
  logFromContext(context: ErrorContext, reason: string): void {
    this.logFallback(
      context.serviceName,
      context.category,
      context.severity,
      reason,
      context.originalError,
      context.details
    );
  }

  /**
   * Update statistics
   */
  private updateStatistics(event: FallbackEvent): void {
    this.statistics.totalFallbacks++;
    this.statistics.lastFallbackTime = event.timestamp;

    if (this.statistics.firstFallbackTime === 0) {
      this.statistics.firstFallbackTime = event.timestamp;
    }

    // By service
    this.statistics.fallbacksByService[event.serviceName] =
      (this.statistics.fallbacksByService[event.serviceName] || 0) + 1;

    // By category
    this.statistics.fallbacksByCategory[event.category] =
      (this.statistics.fallbacksByCategory[event.category] || 0) + 1;

    // By severity
    this.statistics.fallbacksBySeverity[event.severity] =
      (this.statistics.fallbacksBySeverity[event.severity] || 0) + 1;
  }

  /**
   * Write event to log file
   */
  private writeToFile(event: FallbackEvent): void {
    try {
      const logEntry = {
        timestamp: new Date(event.timestamp).toISOString(),
        service: event.serviceName,
        category: event.category,
        severity: event.severity,
        reason: event.reason,
        error: event.error,
        details: event.details,
      };

      const line = JSON.stringify(logEntry) + '\n';
      fs.appendFileSync(this.logFile, line);
    } catch (error) {
      console.error('Failed to write to fallback log file:', error);
    }
  }

  /**
   * Log to console based on severity
   */
  private logToConsole(event: FallbackEvent): void {
    const timestamp = new Date(event.timestamp).toISOString();
    const message = `[${timestamp}] [${event.severity.toUpperCase()}] ${event.serviceName}: ${event.reason}`;

    switch (event.severity) {
      case ErrorSeverity.CRITICAL:
        console.error(`❌ ${message}`);
        break;
      case ErrorSeverity.ERROR:
        console.error(`⚠️  ${message}`);
        break;
      case ErrorSeverity.WARNING:
        console.warn(`⚡ ${message}`);
        break;
    }

    if (event.error) {
      console.debug(`   Error: ${event.error}`);
    }
  }

  /**
   * Get all logged events
   */
  getEvents(): FallbackEvent[] {
    return [...this.events];
  }

  /**
   * Get statistics
   */
  getStatistics(): FallbackStatistics {
    return { ...this.statistics };
  }

  /**
   * Get log count
   */
  getLogCount(): number {
    return this.events.length;
  }

  /**
   * Get events for a specific service
   */
  getEventsByService(serviceName: string): FallbackEvent[] {
    return this.events.filter((e) => e.serviceName === serviceName);
  }

  /**
   * Get events for a specific category
   */
  getEventsByCategory(category: ErrorCategory): FallbackEvent[] {
    return this.events.filter((e) => e.category === category);
  }

  /**
   * Get events for a specific severity
   */
  getEventsBySeverity(severity: ErrorSeverity): FallbackEvent[] {
    return this.events.filter((e) => e.severity === severity);
  }

  /**
   * Get events within a time range
   */
  getEventsByTimeRange(startTime: number, endTime: number): FallbackEvent[] {
    return this.events.filter(
      (e) => e.timestamp >= startTime && e.timestamp <= endTime
    );
  }

  /**
   * Clear events (for testing)
   */
  clear(): void {
    this.events = [];
    this.statistics = {
      totalFallbacks: 0,
      fallbacksByService: {},
      fallbacksByCategory: {},
      fallbacksBySeverity: {},
      lastFallbackTime: 0,
      firstFallbackTime: 0,
    };
  }

  /**
   * Export statistics as Prometheus metrics
   */
  exportPrometheusMetrics(): string {
    let metrics = '';

    // Total fallbacks
    metrics += `# HELP fallback_total Total number of fallback events\n`;
    metrics += `# TYPE fallback_total counter\n`;
    metrics += `fallback_total ${this.statistics.totalFallbacks}\n\n`;

    // By service
    metrics += `# HELP fallback_by_service Fallback events by service\n`;
    metrics += `# TYPE fallback_by_service gauge\n`;
    for (const [service, count] of Object.entries(
      this.statistics.fallbacksByService
    )) {
      metrics += `fallback_by_service{service="${service}"} ${count}\n`;
    }
    metrics += '\n';

    // By category
    metrics += `# HELP fallback_by_category Fallback events by category\n`;
    metrics += `# TYPE fallback_by_category gauge\n`;
    for (const [category, count] of Object.entries(
      this.statistics.fallbacksByCategory
    )) {
      metrics += `fallback_by_category{category="${category}"} ${count}\n`;
    }
    metrics += '\n';

    // By severity
    metrics += `# HELP fallback_by_severity Fallback events by severity\n`;
    metrics += `# TYPE fallback_by_severity gauge\n`;
    for (const [severity, count] of Object.entries(
      this.statistics.fallbacksBySeverity
    )) {
      metrics += `fallback_by_severity{severity="${severity}"} ${count}\n`;
    }

    return metrics;
  }
}

// Global logger instance
let globalLogger: FallbackLogger | null = null;

/**
 * Get or create global logger instance
 */
export function getGlobalLogger(logDir?: string): FallbackLogger {
  if (!globalLogger) {
    globalLogger = new FallbackLogger(logDir);
  }
  return globalLogger;
}

/**
 * Reset global logger (for testing)
 */
export function resetGlobalLogger(): void {
  globalLogger = null;
}
