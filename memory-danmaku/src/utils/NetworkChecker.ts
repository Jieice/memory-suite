/**
 * NetworkChecker - 网络连通性检测工具
 * 
 * 功能：
 * 1. 检测互联网连通性
 * 2. 检测各服务可用性
 * 3. 定期健康检查
 */

import { EventEmitter } from 'events';

// ============ 类型定义 ============

export interface ServiceEndpoint {
  name: string;
  url: string;
  healthPath?: string;
  timeout?: number;
  critical?: boolean;
}

export interface CheckResult {
  name: string;
  available: boolean;
  latencyMs: number;
  error?: string;
  timestamp: number;
}

export interface NetworkStatus {
  internetConnected: boolean;
  services: Map<string, CheckResult>;
  lastCheckTime: number;
}

// ============ 默认端点 ============

const DEFAULT_INTERNET_ENDPOINTS = [
  'https://www.baidu.com',
  'https://www.qq.com',
  'https://www.bilibili.com'
];

// ============ NetworkChecker ============

export class NetworkChecker extends EventEmitter {
  private services: Map<string, ServiceEndpoint> = new Map();
  private status: NetworkStatus;
  private checkTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private checkIntervalMs: number;
  private defaultTimeout: number;
  
  private log: (...args: any[]) => void;

  constructor(
    checkIntervalMs: number = 30000,
    defaultTimeout: number = 5000,
    logger?: (...args: any[]) => void
  ) {
    super();
    this.checkIntervalMs = checkIntervalMs;
    this.defaultTimeout = defaultTimeout;
    this.log = logger || console.log;
    
    this.status = {
      internetConnected: false,
      services: new Map(),
      lastCheckTime: 0
    };
  }

  // ============ 服务注册 ============

  /**
   * 注册服务端点
   */
  registerService(endpoint: ServiceEndpoint): void {
    this.services.set(endpoint.name, endpoint);
    this.status.services.set(endpoint.name, {
      name: endpoint.name,
      available: false,
      latencyMs: 0,
      timestamp: 0
    });
  }

  /**
   * 注册默认服务
   */
  registerDefaultServices(): void {
    const managerPort = process.env.MANAGER_PORT || '8080';
    const memoryPort = process.env.MEMORY_UNIVERSE_PORT || '4005';
    const ttsPort = process.env.TTS_SERVICE_PORT || '4014';
    const live2dPort = process.env.LIVE2D_SERVICE_PORT || '4002';

    const defaults: ServiceEndpoint[] = [
      { name: 'manager', url: `http://127.0.0.1:${managerPort}`, healthPath: '/health', critical: true },
      { name: 'memory', url: `http://127.0.0.1:${memoryPort}`, healthPath: '/api/status', critical: true },
      { name: 'tts', url: `http://127.0.0.1:${ttsPort}`, healthPath: '/health', critical: false },
      { name: 'live2d', url: `http://127.0.0.1:${live2dPort}`, healthPath: '/health', critical: false }
    ];

    for (const endpoint of defaults) {
      this.registerService(endpoint);
    }
  }

  // ============ 检测方法 ============

  /**
   * 检测互联网连通性
   */
  async checkInternet(): Promise<boolean> {
    for (const url of DEFAULT_INTERNET_ENDPOINTS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(url, {
          method: 'HEAD',
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          this.status.internetConnected = true;
          return true;
        }
      } catch {
        continue;
      }
    }

    this.status.internetConnected = false;
    return false;
  }

  /**
   * 检测单个服务
   */
  async checkService(name: string): Promise<CheckResult> {
    const endpoint = this.services.get(name);
    if (!endpoint) {
      return {
        name,
        available: false,
        latencyMs: 0,
        error: '服务未注册',
        timestamp: Date.now()
      };
    }

    const startTime = Date.now();
    const timeout = endpoint.timeout || this.defaultTimeout;
    const url = endpoint.healthPath 
      ? `${endpoint.url}${endpoint.healthPath}`
      : endpoint.url;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const latencyMs = Date.now() - startTime;
      const result: CheckResult = {
        name,
        available: response.ok,
        latencyMs,
        timestamp: Date.now()
      };

      if (!response.ok) {
        result.error = `HTTP ${response.status}`;
      }

      this.status.services.set(name, result);
      return result;

    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const result: CheckResult = {
        name,
        available: false,
        latencyMs,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now()
      };

      this.status.services.set(name, result);
      return result;
    }
  }

  /**
   * 检测所有服务
   */
  async checkAllServices(): Promise<Map<string, CheckResult>> {
    const results = new Map<string, CheckResult>();

    // 并行检测所有服务
    const checks = Array.from(this.services.keys()).map(async (name) => {
      const result = await this.checkService(name);
      results.set(name, result);
    });

    await Promise.allSettled(checks);
    return results;
  }

  /**
   * 执行完整检查
   */
  async checkAll(): Promise<NetworkStatus> {
    const internetConnected = await this.checkInternet();
    await this.checkAllServices();

    this.status.lastCheckTime = Date.now();

    // 发出事件
    this.emit('checked', this.status);

    // 检查关键服务
    const criticalDown: string[] = [];
    for (const [name, endpoint] of this.services) {
      if (endpoint.critical) {
        const result = this.status.services.get(name);
        if (!result?.available) {
          criticalDown.push(name);
        }
      }
    }

    if (criticalDown.length > 0) {
      this.emit('criticalDown', criticalDown);
    }

    if (!internetConnected) {
      this.emit('internetDown');
    }

    return this.status;
  }

  // ============ 定期检查 ============

  /**
   * 启动定期检查
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.log('[NetworkChecker] 启动网络检测');

    // 立即执行一次
    this.checkAll();

    // 定期检查
    this.checkTimer = setInterval(() => {
      this.checkAll();
    }, this.checkIntervalMs);
  }

  /**
   * 停止定期检查
   */
  stop(): void {
    this.isRunning = false;

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    this.log('[NetworkChecker] 已停止');
  }

  // ============ 状态查询 ============

  /**
   * 获取当前状态
   */
  getStatus(): NetworkStatus {
    return this.status;
  }

  /**
   * 检查互联网是否连接
   */
  isInternetConnected(): boolean {
    return this.status.internetConnected;
  }

  /**
   * 检查服务是否可用
   */
  isServiceAvailable(name: string): boolean {
    const result = this.status.services.get(name);
    return result?.available || false;
  }

  /**
   * 检查所有关键服务是否可用
   */
  areCriticalServicesAvailable(): boolean {
    for (const [name, endpoint] of this.services) {
      if (endpoint.critical) {
        const result = this.status.services.get(name);
        if (!result?.available) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * 获取健康摘要
   */
  getSummary(): {
    internetConnected: boolean;
    criticalServicesOk: boolean;
    availableServices: string[];
    unavailableServices: string[];
  } {
    const availableServices: string[] = [];
    const unavailableServices: string[] = [];

    for (const [name, result] of this.status.services) {
      if (result.available) {
        availableServices.push(name);
      } else {
        unavailableServices.push(name);
      }
    }

    return {
      internetConnected: this.status.internetConnected,
      criticalServicesOk: this.areCriticalServicesAvailable(),
      availableServices,
      unavailableServices
    };
  }
}

export default NetworkChecker;
