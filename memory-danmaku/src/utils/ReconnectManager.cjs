/**
 * ReconnectManager - WebSocket 自动重连管理器 (CommonJS 版本)
 * 
 * 功能：
 * 1. 指数退避重连
 * 2. 心跳检测
 * 3. 连接状态监控
 * 4. 最大重试限制
 */

const { EventEmitter } = require('events');

// ============ 默认配置 ============

const DEFAULT_CONFIG = {
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
  maxRetries: -1,
  jitterRatio: 0.3,
  heartbeatIntervalMs: 30000,
  heartbeatTimeoutMs: 10000
};

// ============ ReconnectManager ============

class ReconnectManager extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = 'disconnected';
    this.retryCount = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.heartbeatTimeoutTimer = null;
    this.lastHeartbeatTime = 0;
    this.lastConnectTime = 0;
    this.lastDisconnectTime = 0;
    this.totalReconnects = 0;
    this.consecutiveFailures = 0;
    
    this.connectFn = null;
    this.disconnectFn = null;
    this.heartbeatFn = null;
    
    this.log = logger || console.log;
  }

  // ============ 配置 ============

  setConnectFunction(fn) {
    this.connectFn = fn;
  }

  setDisconnectFunction(fn) {
    this.disconnectFn = fn;
  }

  setHeartbeatFunction(fn) {
    this.heartbeatFn = fn;
  }

  // ============ 连接管理 ============

  async connect() {
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

  disconnect() {
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

  onConnected() {
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

  onDisconnected(reason) {
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

    this.scheduleReconnect();
  }

  onConnectionFailed(error) {
    this.consecutiveFailures++;

    this.log(`[ReconnectManager] ❌ 连接失败: ${error}`);
    this.emit('error', { error, retryCount: this.retryCount });

    if (this.config.maxRetries !== -1 && this.retryCount >= this.config.maxRetries) {
      this.state = 'failed';
      this.emit('stateChange', this.state);
      this.emit('failed', { error, retryCount: this.retryCount });
      this.log(`[ReconnectManager] ❌ 超过最大重试次数 (${this.config.maxRetries})，停止重连`);
      return;
    }

    this.scheduleReconnect();
  }

  // ============ 重连逻辑 ============

  scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
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

  stopReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  calculateDelay() {
    const { initialDelayMs, maxDelayMs, backoffMultiplier, jitterRatio } = this.config;

    let delay = initialDelayMs * Math.pow(backoffMultiplier, this.retryCount);
    delay = Math.min(delay, maxDelayMs);

    const jitter = delay * jitterRatio * (Math.random() * 2 - 1);
    delay = Math.max(initialDelayMs, delay + jitter);

    return Math.floor(delay);
  }

  async forceReconnect() {
    this.log('[ReconnectManager] 🔄 手动触发重连');
    this.stopReconnect();
    this.retryCount = 0;

    if (this.disconnectFn) {
      this.disconnectFn();
    }

    await this.connect();
  }

  // ============ 心跳检测 ============

  startHeartbeat() {
    if (!this.heartbeatFn || this.config.heartbeatIntervalMs <= 0) {
      return;
    }

    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  async sendHeartbeat() {
    if (this.state !== 'connected' || !this.heartbeatFn) {
      return;
    }

    this.heartbeatTimeoutTimer = setTimeout(() => {
      this.log('[ReconnectManager] ⚠️ 心跳超时');
      this.onDisconnected('heartbeat timeout');
    }, this.config.heartbeatTimeoutMs);

    try {
      const success = await this.heartbeatFn();
      
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
      if (this.heartbeatTimeoutTimer) {
        clearTimeout(this.heartbeatTimeoutTimer);
        this.heartbeatTimeoutTimer = null;
      }
      
      this.log('[ReconnectManager] ⚠️ 心跳异常:', error);
      this.onDisconnected('heartbeat error');
    }
  }

  onHeartbeatReceived() {
    this.lastHeartbeatTime = Date.now();
    
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  // ============ 状态查询 ============

  getState() {
    return this.state;
  }

  isConnected() {
    return this.state === 'connected';
  }

  getStats() {
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

  resetStats() {
    this.retryCount = 0;
    this.totalReconnects = 0;
    this.consecutiveFailures = 0;
  }
}

module.exports = { ReconnectManager };
