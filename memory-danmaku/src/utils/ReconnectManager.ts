/**
 * ReconnectManager - WebSocket 自动重连管理器
 * 
 * 功能：
 * 1. 指数退避重连
 * 2. 心跳检测
 * 3. 连接状态监控
 * 4. 最大重试限制
 */

import { EventEmitter } from 'events';

// ============ 类型定义 ============

export type ConnectionState = 
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export interface ReconnectConfig {
  initialDelayMs: number;      // 初始重试延迟（默认 1000）
  maxDelayMs: number;          // 最大重试延迟（默认 60000）
  backoffMultiplier: number;   // 退避倍数（默认 2）
  maxRetries: number;          // 最大重试次数（-1 表示无限，默认 -1）
  jitterRatio: number;         // 抖动比例（默认 0.3）
  heartbeatIntervalMs: number; // 心跳间隔（默认 30000）
  heartbeatTimeoutMs: number;  // 心跳超时（默认 10000）
}

export interface ReconnectStats {
  state: ConnectionState;
  retryCount: number;
  lastConnectTime: number;
  lastDisconnectTime: number;
  totalReconnects: number;
  consecutiveFailures: number;
  uptime: number;
}

// ============ 默认配置 ============

const DEFAULT_CONFIG: ReconnectConfig = {
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
  maxRetries: -1,
  jitterRatio: 0.3,
  heartbeatIntervalMs: 30000,
  heartbeatTimeoutMs: 10000
};

// ============ ReconnectManager ============

export class ReconnectManager extends EventEmitter {
  private config: ReconnectConfig;
  private state: ConnectionState = 'disconnected';
  private retryCount: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
  private lastHeartbeatTime: number = 0;
  private lastConnectTime: number = 0;
  private lastDisconnectTime: number = 0;
  private totalReconnects: number = 0;
  private consecutiveFailures: number = 0;
  
  private connectFn: (() => Promise<void>) | null = null;
  private disconnectFn: (() => void) | null = null;
  private heartbeatFn: (() => Promise<boolean>) | null = null;
  
  private log: (...args: any[]) => void;

  constructor(config?: Partial<ReconnectConfig>, logger?: (...args: any[]) => void) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.log = logger || console.log;
  }

  // ============ 配置 ============

  /**
   * 设置连接函数
   */
  setConnectFunction(fn: () => Promise<void>): void {
    this.connectFn = fn;
  }

  /**
   * 设置断开函数
   */
  setDisconnectFunction(fn: () => void): void {
    this.disconnectFn = fn;
  }

  /**
   * 设置心跳函数（返回 true 表示心跳成功）
   */
  setHeartbeatFunction(fn: () => Promise<boolean>): void {
    this.heartbeatFn = fn;
  }

  // ============ 连接管理 ============

  /**
   * 开始连接
   */
  async connect(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected') {
      this.log('[ReconnectManager] 已经在连接中或已连接');
      return;
    }

    if (!this.connectFn) {
      throw new Error('未设置连接函数');
    }

    this.state = 'connecting';
    this.emit('stateChange', this.state);

    try {
      await this.connectFn();
      this.onConnected();
    } catch (error) {
      this.onConnectionFailed(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.stopReconnect();
    this.stopHeartbeat();

    if (this.disconnectFn) {
      this.disconnectFn();
    }

    this.state = 'disconnected';
    this.lastDisconnectTime = Date.now();
    this.emit('stateChange', this.state);
    this.emit('disconnected', { manual: true });
  }

  /**
   * 通知连接成功（由外部调用）
   */
  onConnected(): void {
    this.state = 'connected';
    this.lastConnectTime = Date.now();
    this.retryCount = 0;
    this.consecutiveFailures = 0;

    this.stopReconnect();
    this.startHeartbeat();

    this.log('[ReconnectManager] ✅ 连接成功');
    this.emit('stateChange', this.state);
    this.emit('connected');
  }

  /**
   * 通知连接断开（由外部调用）
   */
  onDisconnected(reason?: string): void {
    if (this.state === 'disconnected' || this.state === 'failed') {
      return;
    }

    this.state = 'disconnected';
    this.lastDisconnectTime = Date.now();
    this.consecutiveFailures++;

    this.stopHeartbeat();

    this.log(`[ReconnectManager] ❌ 连接断开: ${reason || 'unknown'}`);
    this.emit('stateChange', this.state);
    this.emit('disconnected', { reason, manual: false });

    // 自动重连
    this.scheduleReconnect();
  }

  /**
   * 通知连接失败（由外部调用）
   */
  onConnectionFailed(error: string): void {
    this.consecutiveFailures++;

    this.log(`[ReconnectManager] ❌ 连接失败: ${error}`);
    this.emit('error', { error, retryCount: this.retryCount });

    // 检查是否超过最大重试次数
    if (this.config.maxRetries !== -1 && this.retryCount >= this.config.maxRetries) {
      this.state = 'failed';
      this.emit('stateChange', this.state);
      this.emit('failed', { error, retryCount: this.retryCount });
      this.log(`[ReconnectManager] ❌ 超过最大重试次数 (${this.config.maxRetries})，停止重连`);
      return;
    }

    // 计划重连
    this.scheduleReconnect();
  }

  // ============ 重连逻辑 ============

  /**
   * 计划重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // 已有重连计划
    }

    const delay = this.calculateDelay();
    this.state = 'reconnecting';
    this.retryCount++;

    this.log(`[ReconnectManager] 🔄 ${delay / 1000}秒后重连 (第 ${this.retryCount} 次)`);
    this.emit('stateChange', this.state);
    this.emit('reconnecting', { retryCount: this.retryCount, delayMs: delay });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.totalReconnects++;

      try {
        await this.connect();
      } catch (error) {
        // connect() 内部会处理错误
      }
    }, delay);
  }

  /**
   * 停止重连
   */
  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * 计算重连延迟（指数退避 + 抖动）
   */
  private calculateDelay(): number {
    const { initialDelayMs, maxDelayMs, backoffMultiplier, jitterRatio } = this.config;

    // 指数退避
    let delay = initialDelayMs * Math.pow(backoffMultiplier, this.retryCount);
    delay = Math.min(delay, maxDelayMs);

    // 添加抖动
    const jitter = delay * jitterRatio * (Math.random() * 2 - 1);
    delay = Math.max(initialDelayMs, delay + jitter);

    return Math.floor(delay);
  }

  /**
   * 手动触发重连
   */
  async forceReconnect(): Promise<void> {
    this.log('[ReconnectManager] 🔄 手动触发重连');
    this.stopReconnect();
    this.retryCount = 0;

    if (this.disconnectFn) {
      this.disconnectFn();
    }

    await this.connect();
  }

  // ============ 心跳检测 ============

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    if (!this.heartbeatFn || this.config.heartbeatIntervalMs <= 0) {
      return;
    }

    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  /**
   * 发送心跳
   */
  private async sendHeartbeat(): Promise<void> {
    if (this.state !== 'connected' || !this.heartbeatFn) {
      return;
    }

    // 设置超时
    this.heartbeatTimeoutTimer = setTimeout(() => {
      this.log('[ReconnectManager] ⚠️ 心跳超时');
      this.onDisconnected('heartbeat timeout');
    }, this.config.heartbeatTimeoutMs);

    try {
      const success = await this.heartbeatFn();
      
      // 清除超时
      if (this.heartbeatTimeoutTimer) {
        clearTimeout(this.heartbeatTimeoutTimer);
        this.heartbeatTimeoutTimer = null;
      }

      if (success) {
        this.lastHeartbeatTime = Date.now();
        this.emit('heartbeat');
      } else {
        this.log('[ReconnectManager] ⚠️ 心跳失败');
        this.onDisconnected('heartbeat failed');
      }
    } catch (error) {
      // 清除超时
      if (this.heartbeatTimeoutTimer) {
        clearTimeout(this.heartbeatTimeoutTimer);
        this.heartbeatTimeoutTimer = null;
      }
      
      this.log('[ReconnectManager] ⚠️ 心跳异常:', error);
      this.onDisconnected('heartbeat error');
    }
  }

  /**
   * 通知收到心跳响应（由外部调用）
   */
  onHeartbeatReceived(): void {
    this.lastHeartbeatTime = Date.now();
    
    // 清除超时
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  // ============ 状态查询 ============

  /**
   * 获取当前状态
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * 获取统计信息
   */
  getStats(): ReconnectStats {
    const now = Date.now();
    const uptime = this.state === 'connected' && this.lastConnectTime > 0
      ? now - this.lastConnectTime
      : 0;

    return {
      state: this.state,
      retryCount: this.retryCount,
      lastConnectTime: this.lastConnectTime,
      lastDisconnectTime: this.lastDisconnectTime,
      totalReconnects: this.totalReconnects,
      consecutiveFailures: this.consecutiveFailures,
      uptime
    };
  }

  /**
   * 重置统计
   */
  resetStats(): void {
    this.retryCount = 0;
    this.totalReconnects = 0;
    this.consecutiveFailures = 0;
  }
}

export default ReconnectManager;
