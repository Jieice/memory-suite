// 礼物处理器 - 处理礼物消息
import { QueuedMessage } from '../queue/MessageQueue.js';

export interface DanmakuBroadcaster {
  broadcastDanmaku(data: { username: string; message: string; type: string }): void;
}

export class GiftHandler {
  constructor(
    private broadcaster: DanmakuBroadcaster | null,
    private logger: (...args: any[]) => void
  ) {}
  
  handle(data: any): QueuedMessage {
    const giftData = data.data || {};
    const uname = giftData.uname || '';
    const giftName = giftData.giftName || '';
    const num = giftData.num || 1;
    
    this.logger(`收到礼物: [${uname}] 送出 ${giftName} x${num}`);
    
    const message = `送出 ${giftName} x${num}`;
    
    // 广播到显示页面
    this.broadcaster?.broadcastDanmaku({ 
      username: uname, 
      message, 
      type: 'gift' 
    });
    
    const thankMessage = `感谢 ${uname} 送出的 ${giftName} x${num}！`;
    
    return {
      uname,
      message: thankMessage,
      type: 'gift',
      msgId: `gift_${Date.now()}`,
      priority: 2
    };
  }
}
