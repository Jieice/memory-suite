export interface ConnectionPoolConfig {
  maxSockets: number;
  maxFreeSockets: number;
  keepAlive: boolean;
  keepAliveMsecs: number;
  timeout: number;
  scheduling: 'fifo' | 'lifo';
}

export interface CompressionConfig {
  enabled: boolean;
  minSizeBytes: number;
  algorithm: 'gzip' | 'deflate' | 'br';
}

export interface OptimizedHttpClientConfig {
  connectionPool?: ConnectionPoolConfig;
  compression?: CompressionConfig;
  defaultTimeout?: number;
  defaultRetries?: number;
  retryDelayMs?: number;
}

export interface OptimizedHttpClientStats {
  connectionPool: {
    totalConnections: number;
    freeConnections: number;
    pendingRequests: number;
    requestsServed: number;
    connectionReuses: number;
    avgConnectionTime: number;
  };
  compressionRatio: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgLatency: number;
  totalBytes: number;
  compressedBytes: number;
  batchedRequests: number;
}

export class OptimizedHttpClient {
  private config: OptimizedHttpClientConfig;
  private stats: OptimizedHttpClientStats;

  constructor(config: OptimizedHttpClientConfig = {}) {
    this.config = {
      connectionPool: config.connectionPool || {
        maxSockets: 10,
        maxFreeSockets: 5,
        keepAlive: true,
        keepAliveMsecs: 60000,
        timeout: 30000,
        scheduling: 'fifo'
      },
      compression: config.compression || {
        enabled: false,
        minSizeBytes: 1024,
        algorithm: 'gzip'
      },
      defaultTimeout: config.defaultTimeout ?? 10000,
      defaultRetries: config.defaultRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1000
    };

    this.stats = {
      connectionPool: {
        totalConnections: 0,
        freeConnections: 0,
        pendingRequests: 0,
        requestsServed: 0,
        connectionReuses: 0,
        avgConnectionTime: 0
      },
      compressionRatio: 1,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      avgLatency: 0,
      totalBytes: 0,
      compressedBytes: 0,
      batchedRequests: 0
    };
  }

  getConfig(): OptimizedHttpClientConfig {
    return this.config;
  }

  getStats(): OptimizedHttpClientStats {
    return this.stats;
  }

  resetStats(): void {
    this.stats = {
      connectionPool: {
        totalConnections: 0,
        freeConnections: 0,
        pendingRequests: 0,
        requestsServed: 0,
        connectionReuses: 0,
        avgConnectionTime: 0
      },
      compressionRatio: 1,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      avgLatency: 0,
      totalBytes: 0,
      compressedBytes: 0,
      batchedRequests: 0
    };
  }

  updateConfig(config: Partial<OptimizedHttpClientConfig>): void {
    this.config = { ...this.config, ...config };
  }

  destroy(): void {
    // Placeholder for cleanup
  }
}
