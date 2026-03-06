// 主动行为管理器 - 仅作为 Memory Universe 主动说话的触发器
// 所有决策和内容生成都由 Memory Universe 统一处理
import axios from 'axios';

// 生成追踪ID
function generateTraceId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `proactive_${timestamp}_${random}`;
}

export class ProactiveManager {
  private lastProactiveTime: number = 0;
  private isChecking: boolean = false;
  private readonly MIN_COOLDOWN = 60 * 1000; // 1分钟冷却
  private readonly MIN_SILENCE = 20; // 20秒沉默后才检查
  
  constructor(
    private webManagerUrl: string,
    private userId: string,
    private getLastMessageTime: () => number,
    private isBusy: () => boolean,
    private checkServiceAvailability: () => Promise<boolean>,
    private onProactiveSpeak: (content: string, msgId: string, traceId?: string) => Promise<void>,
    private logger: (...args: any[]) => void
  ) {}
  
  startChecking(intervalMs: number = 5000): void {
    setInterval(async () => {
      await this.checkAndAct();
    }, intervalMs);
    
    this.logger('✅ 主动行为检测已启动（由 Memory Universe 统一调度）');
  }
  
  private async checkAndAct(): Promise<void> {
    if (this.isChecking || this.isBusy()) {
      return;
    }
    
    const traceId = generateTraceId();
    const logPrefix = `[${traceId}]`;
    
    try {
      const silenceDuration = (Date.now() - this.getLastMessageTime()) / 1000;
      
      // 沉默时间太短，不检查
      if (silenceDuration < this.MIN_SILENCE) {
        return;
      }
      
      // 检查冷却时间
      const timeSinceLastProactive = Date.now() - this.lastProactiveTime;
      if (timeSinceLastProactive < this.MIN_COOLDOWN) {
        return;
      }
      
      // 检查服务可用性
      const isAvailable = await this.checkServiceAvailability();
      if (!isAvailable) {
        return;
      }
      
      this.isChecking = true;
      
      // 调用 Memory Universe 的主动说话检查
      // Memory Universe 内部的 ProactiveTalkEngine 会决定是否说话以及说什么
      const response = await axios.post(
        `${this.webManagerUrl}/api/proactive/check`,
        {
          silenceDuration,
          danmakuRate: 0,
          isInConversation: false,
          currentState: 'IDLE',
          riskLevel: 0,
          source: 'danmaku-bridge',
          traceId
        },
        { 
          timeout: 5000,
          headers: {
            'x-trace-id': traceId,
            'x-trace-source': 'danmaku-proactive'
          }
        }
      );
      
      if (response.data?.success && response.data?.decision) {
        const decision = response.data.decision;
        
        // Memory Universe 决定主动说话并返回内容
        if (decision.shouldAct && decision.content) {
          this.logger(`${logPrefix} 🎤 主动说话: ${decision.content.substring(0, 50)}...`);
          this.lastProactiveTime = Date.now();
          await this.onProactiveSpeak(decision.content, `proactive_${Date.now()}`, traceId);
        }
        // 不再有兼容旧逻辑的分支，完全由 Memory Universe 控制
      }
    } catch (error: any) {
      // 静默失败，避免刷屏
      if (error.code !== 'ECONNREFUSED') {
        this.logger(`⚠️ 主动行为检查失败: ${error.message}`);
      }
    } finally {
      this.isChecking = false;
    }
  }
  
  /**
   * 通知有新消息，用于同步状态
   */
  notifyMessage(): void {
    // 有用户互动时不需要特殊处理
    // Memory Universe 会根据实际情况控制主动发言频率
  }
}
