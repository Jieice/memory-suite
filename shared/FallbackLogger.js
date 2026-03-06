"use strict";
/**
 * Structured logging for fallback events
 * Tracks all fallback occurrences for monitoring and debugging
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FallbackLogger = void 0;
exports.getGlobalLogger = getGlobalLogger;
exports.resetGlobalLogger = resetGlobalLogger;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ErrorCategories_1 = require("./ErrorCategories");
/**
 * Fallback Logger - Centralized logging for all fallback events
 */
class FallbackLogger {
    logFile;
    events = [];
    statistics = {
        totalFallbacks: 0,
        fallbacksByService: {},
        fallbacksByCategory: {},
        fallbacksBySeverity: {},
        lastFallbackTime: 0,
        firstFallbackTime: 0,
    };
    constructor(logDir = './logs') {
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
    logFallback(serviceName, category, severity, reason, error, details) {
        const event = {
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
    logFromContext(context, reason) {
        this.logFallback(context.serviceName, context.category, context.severity, reason, context.originalError, context.details);
    }
    /**
     * Update statistics
     */
    updateStatistics(event) {
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
    writeToFile(event) {
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
        }
        catch (error) {
            console.error('Failed to write to fallback log file:', error);
        }
    }
    /**
     * Log to console based on severity
     */
    logToConsole(event) {
        const timestamp = new Date(event.timestamp).toISOString();
        const message = `[${timestamp}] [${event.severity.toUpperCase()}] ${event.serviceName}: ${event.reason}`;
        switch (event.severity) {
            case ErrorCategories_1.ErrorSeverity.CRITICAL:
                console.error(`❌ ${message}`);
                break;
            case ErrorCategories_1.ErrorSeverity.ERROR:
                console.error(`⚠️  ${message}`);
                break;
            case ErrorCategories_1.ErrorSeverity.WARNING:
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
    getEvents() {
        return [...this.events];
    }
    /**
     * Get statistics
     */
    getStatistics() {
        return { ...this.statistics };
    }
    /**
     * Get log count
     */
    getLogCount() {
        return this.events.length;
    }
    /**
     * Get events for a specific service
     */
    getEventsByService(serviceName) {
        return this.events.filter((e) => e.serviceName === serviceName);
    }
    /**
     * Get events for a specific category
     */
    getEventsByCategory(category) {
        return this.events.filter((e) => e.category === category);
    }
    /**
     * Get events for a specific severity
     */
    getEventsBySeverity(severity) {
        return this.events.filter((e) => e.severity === severity);
    }
    /**
     * Get events within a time range
     */
    getEventsByTimeRange(startTime, endTime) {
        return this.events.filter((e) => e.timestamp >= startTime && e.timestamp <= endTime);
    }
    /**
     * Clear events (for testing)
     */
    clear() {
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
    exportPrometheusMetrics() {
        let metrics = '';
        // Total fallbacks
        metrics += `# HELP fallback_total Total number of fallback events\n`;
        metrics += `# TYPE fallback_total counter\n`;
        metrics += `fallback_total ${this.statistics.totalFallbacks}\n\n`;
        // By service
        metrics += `# HELP fallback_by_service Fallback events by service\n`;
        metrics += `# TYPE fallback_by_service gauge\n`;
        for (const [service, count] of Object.entries(this.statistics.fallbacksByService)) {
            metrics += `fallback_by_service{service="${service}"} ${count}\n`;
        }
        metrics += '\n';
        // By category
        metrics += `# HELP fallback_by_category Fallback events by category\n`;
        metrics += `# TYPE fallback_by_category gauge\n`;
        for (const [category, count] of Object.entries(this.statistics.fallbacksByCategory)) {
            metrics += `fallback_by_category{category="${category}"} ${count}\n`;
        }
        metrics += '\n';
        // By severity
        metrics += `# HELP fallback_by_severity Fallback events by severity\n`;
        metrics += `# TYPE fallback_by_severity gauge\n`;
        for (const [severity, count] of Object.entries(this.statistics.fallbacksBySeverity)) {
            metrics += `fallback_by_severity{severity="${severity}"} ${count}\n`;
        }
        return metrics;
    }
}
exports.FallbackLogger = FallbackLogger;
// Global logger instance
let globalLogger = null;
/**
 * Get or create global logger instance
 */
function getGlobalLogger(logDir) {
    if (!globalLogger) {
        globalLogger = new FallbackLogger(logDir);
    }
    return globalLogger;
}
/**
 * Reset global logger (for testing)
 */
function resetGlobalLogger() {
    globalLogger = null;
}
//# sourceMappingURL=FallbackLogger.js.map