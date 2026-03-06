// 上舰处理器 - 处理舰长购买
import { QueuedMessage } from '../queue/MessageQueue.js';

export interface DanmakuBroadcaster {
  broadcastDanmaku(data: { username: string; message: string; type: string }): void;
}

export class GuardHandler {
  constructor(
    private broadcaster: DanmakuBroadcaster | null,
    private logger: (...args: any[]) => void
  ) {}
  
  handle(data: any): QueuedMessage {
    const guardData = data.data || {};
    const uname = guardData.username || '';
    const guardLevel = guardData.guard_level || 1;
    const guardName = ['', '总督', '提督', '舰长'][guardLevel] || '舰长';
    
    this.logger(`收到上舰: [${uname}] 开通了 ${guardName}`);
    
    // 广播到显示页面
    this.broadcaster?.broadcastDanmaku({ 
      username: uname, 
      message: `开通了 ${guardName}`, 
      type: 'guard' 
    });
    
    const message = `感谢 ${uname} 开通了 ${guardName}！欢迎加入舰队！`;
    
    return {
      uname,
      message,
      type: 'guard',
      msgId: `guard_${Date.now()}`,
      priority: 3
    };
  }
}
