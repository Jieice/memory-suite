import { QueuedMessage } from '../queue/MessageQueue.js';
import { getDanmakuStatsService } from '../stats/DanmakuStatsService.js';

export interface DanmakuBroadcaster {
  broadcastDanmaku(data: { username: string; message: string; type: string }): void;
}

export class DanmakuHandler {
  private statsService = getDanmakuStatsService();

  constructor(
    private broadcaster: DanmakuBroadcaster | null,
    private logger: (...args: any[]) => void
  ) {}
  
  handle(data: any): QueuedMessage | null {
    const info = data.info || [];
    const message = info[1] || '';
    const uname = info[2]?.[1] || '';
    const msgId = data.msg_id || `danmaku_${Date.now()}`;
    
    this.logger(`收到弹幕: [${uname}] ${message}`);

    this.statsService.processDanmaku(message, uname);
    
    this.broadcaster?.broadcastDanmaku({ 
      username: uname, 
      message, 
      type: 'danmaku' 
    });
    
    return {
      uname,
      message,
      type: 'danmaku',
      msgId,
      priority: 1
    };
  }
}
