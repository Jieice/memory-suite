/**
 * PerformanceMonitor
 * 
 * Comprehensive performance monitoring for DecisionService and GenerationService
 * Implements detailed metrics collection, bottleneck detection, and alerting
 * 
 * Requirements: 7.1, 7.2, 7.4
 */

// ============================================
// Types and Interfaces
// ============================================

export interface MetricPoint {
  timestamp: number;
  value: number;
  labels?: Record<string, string>;
}

export interface MetricSeries {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  points: MetricPoint[];
  maxPoints: number;
}

export interface ServiceMetrics {
  requestCount: number;
  errorCount: number;
  totalLatency: number;
  latencyHistogram: number[];
  lastRequestTime: number;
  throughput: number;
  errorRate: number;
  avgLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
}

export interface BottleneckInfo {
  service: string;
  type: 'latency' | 'error_rate' | 'throughput' | 'resource';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  metric: string;
  currentValue: number;
  threshold: number;
  timestamp: number;
  recommendations: string[];
}

export interface AlertConfig {
  enabled: boolean;
  latencyThresholdMs: number;
  errorRateThreshold: number;
  throughputMinThreshold: number;
  checkIntervalMs: number;
}

export interface Alert {
  id: string;
  type: 'latency' | 'error_rate' | 'throughput' | 'service_down';
  severity: 'warning' | 'critical';
  service: string;
  message: string;
  timestamp: number;
  resolved: boolean;
  resolvedAt?: number;
}

export interface PerformanceSnapshot {
  timestamp: number;
  services: Record<string, ServiceMetrics>;
  bottlenecks: BottleneckInfo[];
  alerts: Alert[];
  systemHealth: 'healthy' | 'degraded' | 'critical';
}

export interface PerformanceMonitorConfig {
  metricsRetentionMs: number;
  maxMetricPoints: number;
  alertConfig: AlertConfig;
  bottleneckDetectionEnabled: boolean;
  dashboardRefreshMs: number;
}

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: PerformanceMonitorConfig = {
  metricsRetentionMs: 3600000, // 1 hour
  maxMetricPoints: 1000,
  alertConfig: {
    enabled: true,
    latencyThresholdMs: 5000,
    errorRateThreshold: 0.1, // 10%
    throughputMinThreshold: 0.1, // requests per second
    checkIntervalMs: 10000
  },
  bottleneckDetectionEnabled: true,
  dashboardRefreshMs: 5000
};

// ============================================
// PerformanceMonitor Class
// ============================================

export class PerformanceMonitor {
  private config: PerformanceMonitorConfig;
  private serviceMetrics: Map<string, ServiceMetrics>;
  private metricSeries: Map<string, MetricSeries>;
  private latencyBuckets: Map<string, number[]>;
  private alerts: Alert[];
  private bottlenecks: BottleneckInfo[];
  private alertCheckTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private alertListeners: ((alert: Alert) => void)[] = [];
  private startTime: number;

  constructor(config?: Partial<PerformanceMonitorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.serviceMetrics = new Map();
    this.metricSeries = new Map();
    this.latencyBuckets = new Map();
    this.alerts = [];
    this.bottlenecks = [];
    this.startTime = Date.now();

    // Initialize default services
    this.initializeService('decision');
    this.initializeService('generation');
    this.initializeService('orchestrator');
  }

  /**
   * Initialize metrics for a service
   */
  private initializeService(serviceName: string): void {
    this.serviceMetrics.set(serviceName, {
      requestCount: 0,
      errorCount: 0,
      totalLatency: 0,
      latencyHistogram: [],
      lastRequestTime: 0,
      throughput: 0,
      errorRate: 0,
      avgLatency: 0,
      p50Latency: 0,
      p95Latency: 0,
      p99Latency: 0
    });
    this.latencyBuckets.set(serviceName, []);
  }

  /**
   * Start the performance monitor
   */
  start(): void {
    if (this.config.alertConfig.enabled) {
      this.alertCheckTimer = setInterval(
        () => this.checkAlerts(),
        this.config.alertConfig.checkIntervalMs
      );
    }

    // Cleanup old metrics periodically
    this.cleanupTimer = setInterval(
      () => this.cleanupOldMetrics(),
      60000 // Every minute
    );

    console.log('[PerformanceMonitor] Started');
  }

  /**
   * Stop the performance monitor
   */
  stop(): void {
    if (this.alertCheckTimer) {
      clearInterval(this.alertCheckTimer);
      this.alertCheckTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    console.log('[PerformanceMonitor] Stopped');
  }

  /**
   * Record a request metric
   */
  recordRequest(
    serviceName: string,
    latencyMs: number,
    success: boolean,
    labels?: Record<string, string>
  ): void {
    let metrics = this.serviceMetrics.get(serviceName);
    if (!metrics) {
      this.initializeService(serviceName);
      metrics = this.serviceMetrics.get(serviceName)!;
    }

    const now = Date.now();
    metrics.requestCount++;
    metrics.totalLatency += latencyMs;
    metrics.lastRequestTime = now;

    if (!success) {
      metrics.errorCount++;
    }

    // Update latency histogram
    let buckets = this.latencyBuckets.get(serviceName);
    if (!buckets) {
      buckets = [];
      this.latencyBuckets.set(serviceName, buckets);
    }
    buckets.push(latencyMs);

    // Keep only recent latencies for percentile calculation
    if (buckets.length > this.config.maxMetricPoints) {
      buckets.shift();
    }

    // Recalculate derived metrics
    this.updateDerivedMetrics(serviceName);

    // Record to time series
    this.recordMetricPoint(`${serviceName}.latency`, latencyMs, labels);
    this.recordMetricPoint(`${serviceName}.requests`, 1, labels);
    if (!success) {
      this.recordMetricPoint(`${serviceName}.errors`, 1, labels);
    }
  }

  /**
   * Record a metric point to time series
   */
  private recordMetricPoint(
    metricName: string,
    value: number,
    labels?: Record<string, string>
  ): void {
    let series = this.metricSeries.get(metricName);
    if (!series) {
      series = {
        name: metricName,
        type: metricName.includes('latency') ? 'histogram' : 'counter',
        points: [],
        maxPoints: this.config.maxMetricPoints
      };
      this.metricSeries.set(metricName, series);
    }

    series.points.push({
      timestamp: Date.now(),
      value,
      labels
    });

    // Trim old points
    if (series.points.length > series.maxPoints) {
      series.points.shift();
    }
  }

  /**
   * Update derived metrics (throughput, error rate, percentiles)
   */
  private updateDerivedMetrics(serviceName: string): void {
    const metrics = this.serviceMetrics.get(serviceName);
    const buckets = this.latencyBuckets.get(serviceName);
    if (!metrics || !buckets) return;

    // Calculate error rate
    metrics.errorRate = metrics.requestCount > 0
      ? metrics.errorCount / metrics.requestCount
      : 0;

    // Calculate average latency
    metrics.avgLatency = metrics.requestCount > 0
      ? metrics.totalLatency / metrics.requestCount
      : 0;

    // Calculate throughput (requests per second over last minute)
    const oneMinuteAgo = Date.now() - 60000;
    const series = this.metricSeries.get(`${serviceName}.requests`);
    if (series) {
      const recentRequests = series.points.filter(p => p.timestamp > oneMinuteAgo).length;
      metrics.throughput = recentRequests / 60;
    }

    // Calculate percentiles
    if (buckets.length > 0) {
      const sorted = [...buckets].sort((a, b) => a - b);
      metrics.p50Latency = this.percentile(sorted, 50);
      metrics.p95Latency = this.percentile(sorted, 95);
      metrics.p99Latency = this.percentile(sorted, 99);
    }
  }

  /**
   * Calculate percentile from sorted array
   */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  }

  /**
   * Get metrics for a specific service
   */
  getServiceMetrics(serviceName: string): ServiceMetrics | undefined {
    return this.serviceMetrics.get(serviceName);
  }

  /**
   * Get all service metrics
   */
  getAllServiceMetrics(): Record<string, ServiceMetrics> {
    const result: Record<string, ServiceMetrics> = {};
    this.serviceMetrics.forEach((metrics, name) => {
      result[name] = { ...metrics };
    });
    return result;
  }

  /**
   * Detect performance bottlenecks
   */
  detectBottlenecks(): BottleneckInfo[] {
    if (!this.config.bottleneckDetectionEnabled) {
      return [];
    }

    const bottlenecks: BottleneckInfo[] = [];
    const now = Date.now();

    this.serviceMetrics.forEach((metrics, serviceName) => {
      // Check latency bottleneck
      if (metrics.p95Latency > this.config.alertConfig.latencyThresholdMs) {
        const severity = this.calculateSeverity(
          metrics.p95Latency,
          this.config.alertConfig.latencyThresholdMs
        );
        bottlenecks.push({
          service: serviceName,
          type: 'latency',
          severity,
          description: `High P95 latency detected for ${serviceName}`,
          metric: 'p95Latency',
          currentValue: metrics.p95Latency,
          threshold: this.config.alertConfig.latencyThresholdMs,
          timestamp: now,
          recommendations: this.getLatencyRecommendations(serviceName, metrics)
        });
      }

      // Check error rate bottleneck
      if (metrics.errorRate > this.config.alertConfig.errorRateThreshold) {
        const severity = this.calculateSeverity(
          metrics.errorRate,
          this.config.alertConfig.errorRateThreshold
        );
        bottlenecks.push({
          service: serviceName,
          type: 'error_rate',
          severity,
          description: `High error rate detected for ${serviceName}`,
          metric: 'errorRate',
          currentValue: metrics.errorRate,
          threshold: this.config.alertConfig.errorRateThreshold,
          timestamp: now,
          recommendations: this.getErrorRateRecommendations(serviceName, metrics)
        });
      }

      // Check throughput bottleneck (only if service has been active)
      if (metrics.requestCount > 10 && 
          metrics.throughput < this.config.alertConfig.throughputMinThreshold) {
        bottlenecks.push({
          service: serviceName,
          type: 'throughput',
          severity: 'medium',
          description: `Low throughput detected for ${serviceName}`,
          metric: 'throughput',
          currentValue: metrics.throughput,
          threshold: this.config.alertConfig.throughputMinThreshold,
          timestamp: now,
          recommendations: this.getThroughputRecommendations(serviceName, metrics)
        });
      }
    });

    this.bottlenecks = bottlenecks;
    return bottlenecks;
  }

  /**
   * Calculate severity based on how much the value exceeds the threshold
   */
  private calculateSeverity(
    value: number,
    threshold: number
  ): 'low' | 'medium' | 'high' | 'critical' {
    const ratio = value / threshold;
    if (ratio >= 3) return 'critical';
    if (ratio >= 2) return 'high';
    if (ratio >= 1.5) return 'medium';
    return 'low';
  }

  /**
   * Get recommendations for latency issues
   */
  private getLatencyRecommendations(
    serviceName: string,
    metrics: ServiceMetrics
  ): string[] {
    const recommendations: string[] = [];
    
    if (serviceName === 'generation') {
      recommendations.push('Consider reducing LLM max tokens');
      recommendations.push('Check LLM API rate limits');
      recommendations.push('Enable response caching for common queries');
    } else if (serviceName === 'decision') {
      recommendations.push('Review BrainNN model complexity');
      recommendations.push('Check memory graph query performance');
      recommendations.push('Consider caching frequent decisions');
    }
    
    if (metrics.p99Latency > metrics.p95Latency * 2) {
      recommendations.push('Investigate outlier requests causing high P99');
    }
    
    return recommendations;
  }

  /**
   * Get recommendations for error rate issues
   */
  private getErrorRateRecommendations(
    serviceName: string,
    _metrics: ServiceMetrics
  ): string[] {
    const recommendations: string[] = [];
    
    recommendations.push(`Check ${serviceName} logs for error patterns`);
    recommendations.push('Verify service dependencies are healthy');
    recommendations.push('Review recent configuration changes');
    
    if (serviceName === 'generation') {
      recommendations.push('Check LLM API key and quota');
      recommendations.push('Verify prompt templates are valid');
    }
    
    return recommendations;
  }

  /**
   * Get recommendations for throughput issues
   */
  private getThroughputRecommendations(
    serviceName: string,
    _metrics: ServiceMetrics
  ): string[] {
    const recommendations: string[] = [];
    
    recommendations.push(`Check ${serviceName} resource utilization`);
    recommendations.push('Consider horizontal scaling');
    recommendations.push('Review connection pool settings');
    
    return recommendations;
  }

  /**
   * Check and generate alerts
   */
  private checkAlerts(): void {
    const bottlenecks = this.detectBottlenecks();
    const now = Date.now();

    for (const bottleneck of bottlenecks) {
      if (bottleneck.severity === 'high' || bottleneck.severity === 'critical') {
        const alertId = `${bottleneck.service}-${bottleneck.type}`;
        const existingAlert = this.alerts.find(
          a => a.id === alertId && !a.resolved
        );

        if (!existingAlert) {
          const alert: Alert = {
            id: alertId,
            type: bottleneck.type as Alert['type'],
            severity: bottleneck.severity === 'critical' ? 'critical' : 'warning',
            service: bottleneck.service,
            message: bottleneck.description,
            timestamp: now,
            resolved: false
          };
          this.alerts.push(alert);
          this.notifyAlertListeners(alert);
        }
      }
    }

    // Resolve alerts that are no longer active
    for (const alert of this.alerts) {
      if (!alert.resolved) {
        const stillActive = bottlenecks.some(
          b => `${b.service}-${b.type}` === alert.id &&
               (b.severity === 'high' || b.severity === 'critical')
        );
        if (!stillActive) {
          alert.resolved = true;
          alert.resolvedAt = now;
        }
      }
    }

    // Clean up old resolved alerts
    const oneHourAgo = now - 3600000;
    this.alerts = this.alerts.filter(
      a => !a.resolved || (a.resolvedAt && a.resolvedAt > oneHourAgo)
    );
  }

  /**
   * Add alert listener
   */
  onAlert(listener: (alert: Alert) => void): void {
    this.alertListeners.push(listener);
  }

  /**
   * Remove alert listener
   */
  offAlert(listener: (alert: Alert) => void): void {
    const index = this.alertListeners.indexOf(listener);
    if (index !== -1) {
      this.alertListeners.splice(index, 1);
    }
  }

  /**
   * Notify all alert listeners
   */
  private notifyAlertListeners(alert: Alert): void {
    for (const listener of this.alertListeners) {
      try {
        listener(alert);
      } catch (error) {
        console.error('[PerformanceMonitor] Alert listener error:', error);
      }
    }
  }

  /**
   * Get active alerts
   */
  getActiveAlerts(): Alert[] {
    return this.alerts.filter(a => !a.resolved);
  }

  /**
   * Get all alerts (including resolved)
   */
  getAllAlerts(): Alert[] {
    return [...this.alerts];
  }

  /**
   * Get current bottlenecks
   */
  getBottlenecks(): BottleneckInfo[] {
    return [...this.bottlenecks];
  }

  /**
   * Get performance snapshot for dashboard
   */
  getSnapshot(): PerformanceSnapshot {
    const bottlenecks = this.detectBottlenecks();
    const activeAlerts = this.getActiveAlerts();
    
    let systemHealth: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (activeAlerts.some(a => a.severity === 'critical')) {
      systemHealth = 'critical';
    } else if (activeAlerts.length > 0 || bottlenecks.some(b => b.severity === 'high')) {
      systemHealth = 'degraded';
    }

    return {
      timestamp: Date.now(),
      services: this.getAllServiceMetrics(),
      bottlenecks,
      alerts: activeAlerts,
      systemHealth
    };
  }

  /**
   * Get metric time series for charting
   */
  getMetricSeries(metricName: string, durationMs?: number): MetricPoint[] {
    const series = this.metricSeries.get(metricName);
    if (!series) return [];

    if (durationMs) {
      const cutoff = Date.now() - durationMs;
      return series.points.filter(p => p.timestamp > cutoff);
    }

    return [...series.points];
  }

  /**
   * Clean up old metrics
   */
  private cleanupOldMetrics(): void {
    const cutoff = Date.now() - this.config.metricsRetentionMs;

    this.metricSeries.forEach(series => {
      series.points = series.points.filter(p => p.timestamp > cutoff);
    });
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.serviceMetrics.forEach((metrics, name) => {
      this.serviceMetrics.set(name, {
        requestCount: 0,
        errorCount: 0,
        totalLatency: 0,
        latencyHistogram: [],
        lastRequestTime: 0,
        throughput: 0,
        errorRate: 0,
        avgLatency: 0,
        p50Latency: 0,
        p95Latency: 0,
        p99Latency: 0
      });
    });
    this.latencyBuckets.forEach((_, name) => {
      this.latencyBuckets.set(name, []);
    });
    this.metricSeries.clear();
    this.alerts = [];
    this.bottlenecks = [];
    console.log('[PerformanceMonitor] Metrics reset');
  }

  /**
   * Get configuration
   */
  getConfig(): PerformanceMonitorConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<PerformanceMonitorConfig>): void {
    this.config = { ...this.config, ...newConfig };
    
    // Restart alert timer if interval changed
    if (newConfig.alertConfig?.checkIntervalMs && this.alertCheckTimer) {
      clearInterval(this.alertCheckTimer);
      this.alertCheckTimer = setInterval(
        () => this.checkAlerts(),
        this.config.alertConfig.checkIntervalMs
      );
    }
  }

  /**
   * Get uptime in seconds
   */
  getUptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }
}

// Export singleton instance
export const performanceMonitor = new PerformanceMonitor();
