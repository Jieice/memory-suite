// 断路器模式 - 防止故障时无限重试
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private failureCount: number = 0;
  private state: CircuitState = 'CLOSED';
  private lastFailureTime: number | null = null;
  private successCount: number = 0;
  
  constructor(
    private threshold: number = 3,
    private timeout: number = 60000,
    private logger: (...args: any[]) => void
  ) {}
  
  async execute<T>(
    fn: () => Promise<T>,
    fallback?: () => Promise<T>
  ): Promise<T | null> {
    if (this.state === 'OPEN') {
      const timeSinceFailure = Date.now() - (this.lastFailureTime || 0);
      if (timeSinceFailure > this.timeout) {
        this.logger(`🔄 断路器进入 HALF_OPEN 状态，尝试恢复... (已等待 ${Math.floor(timeSinceFailure / 1000)}秒)`);
        this.state = 'HALF_OPEN';
      } else {
        const remainingTime = Math.ceil((this.timeout - timeSinceFailure) / 1000);
        this.logger(`🚫 断路器 OPEN，使用降级方案 (${remainingTime}秒后重试)`);
        return fallback ? await fallback() : null;
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      this.logger(`✅ 断路器: 调用成功，状态=${this.state}`);
      return result;
    } catch (err: any) {
      this.logger(`❌ 断路器: 调用失败 - ${err.message}`);
      this.onFailure();
      if (fallback) {
        this.logger(`🚫 断路器已打开，使用降级方案`);
        return await fallback();
      }
      throw err;
    }
  }
  
  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.logger(`🔄 断路器已手动重置`);
  }
  
  private onSuccess(): void {
    this.failureCount = 0;
    this.successCount++;
    
    if (this.state === 'HALF_OPEN') {
      if (this.successCount >= 2) {
        this.logger(`✅ 断路器恢复到 CLOSED 状态`);
        this.state = 'CLOSED';
        this.successCount = 0;
      }
    } else {
      this.state = 'CLOSED';
    }
  }
  
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.successCount = 0;
    
    this.logger(`❌ 连接失败 (${this.failureCount}/${this.threshold})`);
    
    if (this.failureCount >= this.threshold) {
      this.logger(`🚫 断路器打开，进入 OPEN 状态`);
      this.state = 'OPEN';
    }
  }
  
  getState(): { state: CircuitState; failureCount: number; lastFailureTime: number | null } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime
    };
  }
}
