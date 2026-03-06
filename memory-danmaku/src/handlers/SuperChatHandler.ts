// SC处理器 - 处理超级留言
import { QueuedMessage } from '../queue/MessageQueue.js';

export interface DanmakuBroadcaster {
  broadcastDanmaku(data: { username: string; message: string; type: string }): void;
}

export class SuperChatHandler {
  constructor(
    private broadcaster: DanmakuBroadcaster | null,
    private logger: (...args: any[]) => void
  ) {}
  
  handle(data: any): QueuedMessage {
    const scData = data.data || {};
    const uname = scData.user_info?.uname || '';
    const message = scData.message || '';
    const price = scData.price || 0;
    
    this.logger(`收到SC: [${uname}] ¥${price} - ${message}`);
    
    // 广播到显示页面
    this.broadcaster?.broadcastDanmaku({ 
      username: uname, 
      message: `¥${price} ${message}`, 
      type: 'superchat' 
    });
    
    const thankMessage = `感谢 ${uname} 的 ${price}元 超级留言：${message}`;
    
    return {
      uname,
      message: thankMessage,
      type: 'superchat',
      msgId: `sc_${Date.now()}`,
      priority: 3
    };
  }
}
