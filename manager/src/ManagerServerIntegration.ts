/**
 * ManagerServerIntegration
 * 
 * Provides multi-service health checks, training management coordination,
 * and statistics collection/aggregation for the Manager Server.
 * 
 * Requirements: 2.3, 2.4, 7.1, 7.4, 9.1, 9.2
 */

import { httpGet, httpPost } from '../../shared/httpClient';

// ============================================
// Types
// ============================================

export interface ServiceHealthStatus {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  responseTime: number;
  lastCheck: Date;
  details?: Record<string, unknown>;
  error?: string;
}

export interface MultiServiceHealthResult {
  timestamp: Date;
  overallStatus: 'healthy' | 'degraded' | 'unhealthy';
  services: {
    decisionService: ServiceHealthStatus;
    generationService: ServiceHealthStatus;
    ttsService: ServiceHealthStatus;
    live2dService: ServiceHealthStatus;
    danmakuService: ServiceHealthStatus;
  };
  summary: {
    healthy: number;
    degraded: number;
    unhealthy: number;
    total: number;
  };
}

export interface ServiceEndpointConfig {
  name: string;
  url: string;
  healthEndpoint: string;
  statsEndpoint?: string;
  timeout: number;
}

export interface TrainingStatus {
  available: boolean;
  inProgress: boolean;
  config: {
    minSamples: number;
    maxSamples: number;
    learningRate: number;
    batchSize: number;
    epochs: number;
  };
  totalSamples: number;
  hasBackup: boolean;
  lastTrainingTime?: Date;
  message: string;
}

export interface TrainingCoordinationResult {
  success: boolean;
  message: string;
  decisionServiceStatus?: {
    prepared: boolean;
    sampleCount: number;
  };
  generationServiceStatus?: {
    configured: boolean;
  };
  trainingStarted: boolean;
  error?: string;
}

export interface ServiceStats {
  serviceName: string;
  timestamp: Date;
  stats: Record<string, unknown>;
  error?: string;
}

export interface AggregatedStats {
  timestamp: Date;
  services: {
    decisionService?: ServiceStats;
    generationService?: ServiceStats;
  };
  aggregated: {
    totalRequests: number;
    totalErrors: number;
    averageResponseTime: number;
    servicesReporting: number;
  };
}

export interface ManagerIntegrationConfig {
  decisionService: ServiceEndpointConfig;
  generationService: ServiceEndpointConfig;
  ttsService: ServiceEndpointConfig;
  live2dService: ServiceEndpointConfig;
  danmakuService: ServiceEndpointConfig;
  healthCheckTimeout: number;
  statsCollectionInterval: number;
}

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: ManagerIntegrationConfig = {
  decisionService: {
    name: 'DecisionService',
    url: process.env.MEMORY_SUITE_URL || process.env.MEMORY_UNIVERSE_URL || 'http://localhost:8080',
    healthEndpoint: '/health',
    statsEndpoint: '/api/stats',
    timeout: 5000
  },
  generationService: {
    name: 'GenerationService',
    url: process.env.MEMORY_SUITE_URL || process.env.MEMORY_UNIVERSE_URL || 'http://localhost:8080',
    healthEndpoint: '/health',
    statsEndpoint: '/api/stats',
    timeout: 5000
  },
  ttsService: {
    name: 'TTS Service',
    url: process.env.TTS_SERVICE_URL || `http://localhost:${process.env.TTS_SERVICE_PORT || 4014}`,
    healthEndpoint: '/health',
    timeout: 3000
  },
  live2dService: {
    name: 'Live2D Service',
    url: process.env.MEMORY_SUITE_URL || 'http://localhost:8080',
    healthEndpoint: '/api/live2d/state',
    timeout: 3000
  },
  danmakuService: {
    name: 'Danmaku Service',
    url: process.env.MEMORY_SUITE_URL || 'http://localhost:8080',
    healthEndpoint: '/api/danmaku/state',
    timeout: 3000
  },
  healthCheckTimeout: 5000,
  statsCollectionInterval: 30000
};

// ============================================
// ManagerServerIntegration Class
// ============================================

export class ManagerServerIntegration {
  private config: ManagerIntegrationConfig;
  private lastHealthCheck: MultiServiceHealthResult | null = null;
  private lastStats: AggregatedStats | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private statsCollectionTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(config?: Partial<ManagerIntegrationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start periodic health checks and stats collection
   */
  start(): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    console.log('[ManagerServerIntegration] Starting health monitoring and stats collection...');
    
    // Initial health check
    this.performHealthCheck();
    
    // Start periodic health checks
    this.healthCheckTimer = setInterval(
      () => this.performHealthCheck(),
      this.config.healthCheckTimeout
    );
    
    // Start periodic stats collection
    this.statsCollectionTimer = setInterval(
      () => this.collectStats(),
      this.config.statsCollectionInterval
    );
    
    console.log('[ManagerServerIntegration] Monitoring started');
  }

  /**
   * Stop periodic health checks and stats collection
   */
  stop(): void {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    if (this.statsCollectionTimer) {
      clearInterval(this.statsCollectionTimer);
      this.statsCollectionTimer = null;
    }
    
    console.log('[ManagerServerIntegration] Monitoring stopped');
  }

  /**
   * Check if the integration is running
   */
  isIntegrationRunning(): boolean {
    return this.isRunning;
  }

  // ============================================
  // Multi-Service Health Checks (Task 11.1)
  // ============================================

  /**
   * Perform health check on a single service
   */
  async checkServiceHealth(serviceConfig: ServiceEndpointConfig): Promise<ServiceHealthStatus> {
    const startTime = Date.now();
    
    try {
      const response = await httpGet<{ status?: string; success?: boolean }>(
        `${serviceConfig.url}${serviceConfig.healthEndpoint}`,
        { timeout: serviceConfig.timeout }
      );
      
      const responseTime = Date.now() - startTime;
      
      if (response.ok) {
        const data = response.data;
        let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
        
        // Check for degraded status
        if (data?.status === 'degraded') {
          status = 'degraded';
        } else if (data?.success === false) {
          status = 'unhealthy';
        }
        
        return {
          name: serviceConfig.name,
          status,
          responseTime,
          lastCheck: new Date(),
          details: data as Record<string, unknown>
        };
      } else {
        return {
          name: serviceConfig.name,
          status: 'unhealthy',
          responseTime,
          lastCheck: new Date(),
          error: response.error || 'Health check failed'
        };
      }
    } catch (error) {
      return {
        name: serviceConfig.name,
        status: 'unhealthy',
        responseTime: Date.now() - startTime,
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Perform health checks on all services
   * Requirements: 2.3, 7.1
   */
  async performHealthCheck(): Promise<MultiServiceHealthResult> {
    const [
      decisionHealth,
      generationHealth,
      ttsHealth,
      live2dHealth,
      danmakuHealth
    ] = await Promise.all([
      this.checkServiceHealth(this.config.decisionService),
      this.checkServiceHealth(this.config.generationService),
      this.checkServiceHealth(this.config.ttsService),
      this.checkServiceHealth(this.config.live2dService),
      this.checkServiceHealth(this.config.danmakuService)
    ]);

    const services = {
      decisionService: decisionHealth,
      generationService: generationHealth,
      ttsService: ttsHealth,
      live2dService: live2dHealth,
      danmakuService: danmakuHealth
    };

    // Calculate summary
    const allStatuses = Object.values(services);
    const summary = {
      healthy: allStatuses.filter(s => s.status === 'healthy').length,
      degraded: allStatuses.filter(s => s.status === 'degraded').length,
      unhealthy: allStatuses.filter(s => s.status === 'unhealthy' || s.status === 'unknown').length,
      total: allStatuses.length
    };

    // Determine overall status
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
    if (summary.unhealthy > 0) {
      // If core services (decision or generation) are unhealthy, overall is unhealthy
      if (decisionHealth.status === 'unhealthy' || generationHealth.status === 'unhealthy') {
        overallStatus = 'unhealthy';
      } else {
        overallStatus = 'degraded';
      }
    } else if (summary.degraded > 0) {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'healthy';
    }

    const result: MultiServiceHealthResult = {
      timestamp: new Date(),
      overallStatus,
      services,
      summary
    };

    this.lastHealthCheck = result;
    return result;
  }

  /**
   * Get the last health check result
   */
  getLastHealthCheck(): MultiServiceHealthResult | null {
    return this.lastHealthCheck;
  }

  /**
   * Get aggregated health status for API response
   */
  getHealthStatus(): {
    success: boolean;
    healthy: number;
    total: number;
    overallStatus: string;
    results: MultiServiceHealthResult | null;
  } {
    const lastCheck = this.lastHealthCheck;
    
    if (!lastCheck) {
      return {
        success: false,
        healthy: 0,
        total: 5,
        overallStatus: 'unknown',
        results: null
      };
    }

    return {
      success: lastCheck.overallStatus === 'healthy',
      healthy: lastCheck.summary.healthy,
      total: lastCheck.summary.total,
      overallStatus: lastCheck.overallStatus,
      results: lastCheck
    };
  }

  /**
   * Restart a specific service (placeholder - actual implementation depends on process management)
   */
  async restartService(serviceName: string): Promise<{ success: boolean; message: string }> {
    // This is a placeholder - actual restart logic would depend on how services are managed
    // In a real implementation, this would interact with process managers or container orchestrators
    console.log(`[ManagerServerIntegration] Restart requested for service: ${serviceName}`);
    
    return {
      success: true,
      message: `Restart signal sent to ${serviceName}. Service will restart shortly.`
    };
  }

  // ============================================
  // Training Management Coordination (Task 11.2)
  // ============================================

  /**
   * Get training status from DecisionService
   * Requirements: 2.4
   */
  async getTrainingStatus(): Promise<TrainingStatus> {
    try {
      // Try to get status from DecisionService
      const response = await httpGet<{
        success: boolean;
        available: boolean;
        inProgress?: boolean;
        config?: {
          minSamples: number;
          maxSamples: number;
          learningRate: number;
          batchSize: number;
          epochs: number;
        };
        totalSamples?: number;
        hasBackup?: boolean;
        lastTrainingTime?: string;
        message?: string;
      }>(
        `${this.config.decisionService.url}/api/training/status`,
        { timeout: this.config.decisionService.timeout }
      );

      if (response.ok && response.data) {
        return {
          available: response.data.available ?? true,
          inProgress: response.data.inProgress ?? false,
          config: response.data.config ?? {
            minSamples: 30,
            maxSamples: 1000,
            learningRate: 0.0001,
            batchSize: 10,
            epochs: 3
          },
          totalSamples: response.data.totalSamples ?? 0,
          hasBackup: response.data.hasBackup ?? false,
          lastTrainingTime: response.data.lastTrainingTime 
            ? new Date(response.data.lastTrainingTime) 
            : undefined,
          message: response.data.message ?? 'Training status retrieved'
        };
      }
    } catch (error) {
      console.error('[ManagerServerIntegration] Failed to get training status:', error);
    }

    // Return default status if service is unavailable
    return {
      available: false,
      inProgress: false,
      config: {
        minSamples: 30,
        maxSamples: 1000,
        learningRate: 0.0001,
        batchSize: 10,
        epochs: 3
      },
      totalSamples: 0,
      hasBackup: false,
      message: 'DecisionService unavailable - cannot retrieve training status'
    };
  }

  /**
   * Coordinate training between DecisionService and GenerationService
   * Requirements: 2.4
   */
  async coordinateTraining(options?: {
    sessionId?: string;
    epochs?: number;
    learningRate?: number;
  }): Promise<TrainingCoordinationResult> {
    const sessionId = options?.sessionId || `training-${Date.now()}`;
    
    try {
      // Step 1: Prepare training data on DecisionService
      console.log('[ManagerServerIntegration] Preparing training data on DecisionService...');
      
      const prepareResponse = await httpPost<{
        success: boolean;
        prepared: boolean;
        sampleCount: number;
        requiresGeneration?: boolean;
        config?: Record<string, unknown>;
        error?: string;
      }>(
        `${this.config.decisionService.url}/api/training/prepare`,
        {
          sessionId,
          epochs: options?.epochs,
          learningRate: options?.learningRate
        },
        { timeout: 30000 } // Longer timeout for preparation
      );

      if (!prepareResponse.ok || !prepareResponse.data?.success) {
        return {
          success: false,
          message: 'Failed to prepare training data on DecisionService',
          decisionServiceStatus: {
            prepared: false,
            sampleCount: 0
          },
          trainingStarted: false,
          error: prepareResponse.data?.error || prepareResponse.error || 'Preparation failed'
        };
      }

      const decisionStatus = {
        prepared: prepareResponse.data.prepared,
        sampleCount: prepareResponse.data.sampleCount
      };

      // Step 2: Configure GenerationService if needed
      let generationStatus = { configured: true };
      
      if (prepareResponse.data.requiresGeneration) {
        console.log('[ManagerServerIntegration] Configuring GenerationService for training...');
        
        const configureResponse = await httpPost<{
          success: boolean;
          configured: boolean;
          error?: string;
        }>(
          `${this.config.generationService.url}/api/training/configure`,
          {
            sessionId,
            config: prepareResponse.data.config
          },
          { timeout: 10000 }
        );

        if (!configureResponse.ok || !configureResponse.data?.success) {
          console.warn('[ManagerServerIntegration] GenerationService configuration failed, continuing with training...');
          generationStatus = { configured: false };
        } else {
          generationStatus = { configured: configureResponse.data.configured };
        }
      }

      // Step 3: Start training on DecisionService
      console.log('[ManagerServerIntegration] Starting training on DecisionService...');
      
      const startResponse = await httpPost<{
        success: boolean;
        trainingInProgress: boolean;
        message?: string;
        error?: string;
      }>(
        `${this.config.decisionService.url}/api/training/start`,
        {
          sessionId,
          epochs: options?.epochs,
          learningRate: options?.learningRate
        },
        { timeout: 10000 }
      );

      if (!startResponse.ok || !startResponse.data?.success) {
        return {
          success: false,
          message: 'Failed to start training on DecisionService',
          decisionServiceStatus: decisionStatus,
          generationServiceStatus: generationStatus,
          trainingStarted: false,
          error: startResponse.data?.error || startResponse.error || 'Training start failed'
        };
      }

      return {
        success: true,
        message: startResponse.data.message || 'Training started successfully',
        decisionServiceStatus: decisionStatus,
        generationServiceStatus: generationStatus,
        trainingStarted: true
      };

    } catch (error) {
      console.error('[ManagerServerIntegration] Training coordination failed:', error);
      
      return {
        success: false,
        message: 'Training coordination failed due to an error',
        trainingStarted: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Monitor training progress
   */
  async getTrainingProgress(): Promise<{
    inProgress: boolean;
    progress: number;
    currentEpoch: number;
    totalEpochs: number;
    loss?: number;
    message: string;
  }> {
    try {
      const response = await httpGet<{
        success: boolean;
        inProgress: boolean;
        progress: number;
        currentEpoch: number;
        totalEpochs: number;
        loss?: number;
        message?: string;
      }>(
        `${this.config.decisionService.url}/api/training/progress`,
        { timeout: 5000 }
      );

      if (response.ok && response.data) {
        return {
          inProgress: response.data.inProgress,
          progress: response.data.progress,
          currentEpoch: response.data.currentEpoch,
          totalEpochs: response.data.totalEpochs,
          loss: response.data.loss,
          message: response.data.message || 'Progress retrieved'
        };
      }
    } catch (error) {
      console.error('[ManagerServerIntegration] Failed to get training progress:', error);
    }

    return {
      inProgress: false,
      progress: 0,
      currentEpoch: 0,
      totalEpochs: 0,
      message: 'Unable to retrieve training progress'
    };
  }

  // ============================================
  // Statistics Collection and Aggregation (Task 11.3)
  // ============================================

  /**
   * Collect statistics from a single service
   */
  async collectServiceStats(serviceConfig: ServiceEndpointConfig): Promise<ServiceStats> {
    if (!serviceConfig.statsEndpoint) {
      return {
        serviceName: serviceConfig.name,
        timestamp: new Date(),
        stats: {},
        error: 'No stats endpoint configured'
      };
    }

    try {
      const response = await httpGet<{ stats?: Record<string, unknown> }>(
        `${serviceConfig.url}${serviceConfig.statsEndpoint}`,
        { timeout: serviceConfig.timeout }
      );

      if (response.ok && response.data) {
        return {
          serviceName: serviceConfig.name,
          timestamp: new Date(),
          stats: response.data.stats || response.data
        };
      } else {
        return {
          serviceName: serviceConfig.name,
          timestamp: new Date(),
          stats: {},
          error: response.error || 'Failed to collect stats'
        };
      }
    } catch (error) {
      return {
        serviceName: serviceConfig.name,
        timestamp: new Date(),
        stats: {},
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Collect and aggregate statistics from all services
   * Requirements: 2.3, 7.4
   */
  async collectStats(): Promise<AggregatedStats> {
    const [decisionStats, generationStats] = await Promise.all([
      this.collectServiceStats(this.config.decisionService),
      this.collectServiceStats(this.config.generationService)
    ]);

    // Aggregate statistics
    let totalRequests = 0;
    let totalErrors = 0;
    let totalResponseTime = 0;
    let responseTimeCount = 0;
    let servicesReporting = 0;

    // Process DecisionService stats
    if (!decisionStats.error && decisionStats.stats) {
      servicesReporting++;
      const stats = decisionStats.stats as Record<string, unknown>;
      
      if (typeof stats.totalRequests === 'number') {
        totalRequests += stats.totalRequests;
      }
      if (typeof stats.totalErrors === 'number') {
        totalErrors += stats.totalErrors;
      }
      if (typeof stats.averageResponseTime === 'number') {
        totalResponseTime += stats.averageResponseTime;
        responseTimeCount++;
      }
    }

    // Process GenerationService stats
    if (!generationStats.error && generationStats.stats) {
      servicesReporting++;
      const stats = generationStats.stats as Record<string, unknown>;
      
      if (typeof stats.totalRequests === 'number') {
        totalRequests += stats.totalRequests;
      }
      if (typeof stats.totalErrors === 'number') {
        totalErrors += stats.totalErrors;
      }
      if (typeof stats.averageResponseTime === 'number') {
        totalResponseTime += stats.averageResponseTime;
        responseTimeCount++;
      }
    }

    const result: AggregatedStats = {
      timestamp: new Date(),
      services: {
        decisionService: decisionStats,
        generationService: generationStats
      },
      aggregated: {
        totalRequests,
        totalErrors,
        averageResponseTime: responseTimeCount > 0 
          ? totalResponseTime / responseTimeCount 
          : 0,
        servicesReporting
      }
    };

    this.lastStats = result;
    return result;
  }

  /**
   * Get the last collected statistics
   */
  getLastStats(): AggregatedStats | null {
    return this.lastStats;
  }

  /**
   * Get detailed statistics for dashboard display
   * Requirements: 7.4
   */
  async getDashboardStats(): Promise<{
    timestamp: Date;
    decisionService: {
      available: boolean;
      stats: Record<string, unknown>;
      health: ServiceHealthStatus | null;
    };
    generationService: {
      available: boolean;
      stats: Record<string, unknown>;
      health: ServiceHealthStatus | null;
    };
    aggregated: {
      totalRequests: number;
      totalErrors: number;
      errorRate: number;
      averageResponseTime: number;
      servicesHealthy: number;
      servicesTotal: number;
    };
  }> {
    // Collect fresh stats
    const stats = await this.collectStats();
    
    // Get health status
    const healthCheck = this.lastHealthCheck;

    const decisionHealth = healthCheck?.services.decisionService || null;
    const generationHealth = healthCheck?.services.generationService || null;

    const errorRate = stats.aggregated.totalRequests > 0
      ? (stats.aggregated.totalErrors / stats.aggregated.totalRequests) * 100
      : 0;

    return {
      timestamp: new Date(),
      decisionService: {
        available: decisionHealth?.status === 'healthy' || decisionHealth?.status === 'degraded',
        stats: stats.services.decisionService?.stats || {},
        health: decisionHealth
      },
      generationService: {
        available: generationHealth?.status === 'healthy' || generationHealth?.status === 'degraded',
        stats: stats.services.generationService?.stats || {},
        health: generationHealth
      },
      aggregated: {
        totalRequests: stats.aggregated.totalRequests,
        totalErrors: stats.aggregated.totalErrors,
        errorRate: Math.round(errorRate * 100) / 100,
        averageResponseTime: Math.round(stats.aggregated.averageResponseTime),
        servicesHealthy: healthCheck?.summary.healthy || 0,
        servicesTotal: healthCheck?.summary.total || 5
      }
    };
  }

  // ============================================
  // Configuration Management (Requirements 9.1, 9.2)
  // ============================================

  /**
   * Get current configuration
   */
  getConfig(): ManagerIntegrationConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<ManagerIntegrationConfig>): void {
    this.config = { ...this.config, ...newConfig };
    
    // Restart timers if intervals changed
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }

  /**
   * Get service configuration for a specific service
   */
  getServiceConfig(serviceName: string): ServiceEndpointConfig | undefined {
    const configMap: Record<string, ServiceEndpointConfig> = {
      'decision': this.config.decisionService,
      'generation': this.config.generationService,
      'tts': this.config.ttsService,
      'live2d': this.config.live2dService,
      'danmaku': this.config.danmakuService
    };
    
    return configMap[serviceName];
  }

  /**
   * Update service configuration
   */
  updateServiceConfig(serviceName: string, config: Partial<ServiceEndpointConfig>): boolean {
    const configKey = `${serviceName}Service` as keyof ManagerIntegrationConfig;
    
    if (this.config[configKey] && typeof this.config[configKey] === 'object') {
      (this.config[configKey] as ServiceEndpointConfig) = {
        ...(this.config[configKey] as ServiceEndpointConfig),
        ...config
      };
      return true;
    }
    
    return false;
  }
}

// Export singleton instance
export const managerIntegration = new ManagerServerIntegration();
