// WebSocket管理器 - 管理弹幕WebSocket连接
import { LiveWS } from 'laplace-blive-ws';
import { DanmakuHandler } from '../handlers/DanmakuHandler.js';
import { GiftHandler } from '../handlers/GiftHandler.js';
import { SuperChatHandler } from '../handlers/SuperChatHandler.js';
import { GuardHandler } from '../handlers/GuardHandler.js';
import { MessageQueue } from '../queue/MessageQueue.js';

export interface DanmuInfo {
  token: string;
  host_list: Array<{ host: string; port: number; wss_port: number }>;
  live_status?: number;
  uid?: number;
}

export class WebSocketManager {
  private liveInstance: LiveWS | null = null;
  
  constructor(
    private roomId: number,
    private userUid: number,
    private buvid: string,
    private danmakuHandler: DanmakuHandler,
    private giftHandler: GiftHandler,
    private superChatHandler: SuperChatHandler,
    private guardHandler: GuardHandler,
    private messageQueue: MessageQueue,
    private shouldProcessDanmaku: (message: string) => boolean,
    private onClose: () => void,
    private onError: () => void,
    private logger: (...args: any[]) => void
  ) {}
  
  connect(danmuInfo: DanmuInfo): void {
    const liveStatus = danmuInfo.live_status ?? 1;
    if (liveStatus !== 1) {
      this.logger(`房间尚未正式开播 (live_status=${liveStatus}), 但仍尝试连接`);
    }
    
    const token = danmuInfo.token;
    if (!token) {
      this.logger('token 缺失，无法授权');
      this.onError();
      return;
    }
    
    const host = danmuInfo.host_list[0];
    const address = host ? `wss://${host.host}:${host.wss_port}/sub` : undefined;
    const uid = this.userUid || Number(danmuInfo.uid || 0);
    
    this.logger('开始连接弹幕', { 
      roomId: this.roomId,
      uid, 
      address: address || 'default',
      token: token ? '✓' : '✗',
      buvid: this.buvid || 'empty'
    });
    
    this.liveInstance = new LiveWS(this.roomId, {
      key: token,
      uid,
      buvid: this.buvid,
      address
    });
    
    this.liveInstance.on('open', () => {
      this.logger('✅ WebSocket 连接已建立');
    });
    
    this.liveInstance.on('live', () => {
      this.logger('✅ 弹幕连接成功，开始接收弹幕');
    });
    
    this.liveInstance.on('close', (reason) => {
      this.logger('❌ 连接关闭:', this.safeReason(reason));
      this.onClose();
    });
    
    this.liveInstance.on('error', (err) => {
      this.logger('❌ 连接错误:', this.safeReason(err));
      this.onError();
    });
    
    this.liveInstance.on('heartbeat', () => {});
    
    this.liveInstance.on('msg', (data) => {
      try {
        const cmd = data?.cmd || '';
        
        if (cmd === 'DANMU_MSG') {
          const msg = this.danmakuHandler.handle(data);
          if (msg && this.shouldProcessDanmaku(msg.message)) {
            this.messageQueue.enqueue(msg);
          }
        } else if (cmd === 'SEND_GIFT') {
          const msg = this.giftHandler.handle(data);
          this.messageQueue.enqueue(msg);
        } else if (cmd === 'SUPER_CHAT_MESSAGE') {
          const msg = this.superChatHandler.handle(data);
          this.messageQueue.enqueue(msg);
        } else if (cmd === 'GUARD_BUY') {
          const msg = this.guardHandler.handle(data);
          this.messageQueue.enqueue(msg);
        }
      } catch (err: any) {
        this.logger('处理消息失败', err.message || err);
      }
    });
  }
  
  close(): void {
    if (this.liveInstance) {
      this.liveInstance.close();
      this.liveInstance = null;
    }
  }
  
  isConnected(): boolean {
    return this.liveInstance !== null;
  }
  
  private safeReason(reason: any): string {
    if (!reason) return '';
    if (Buffer.isBuffer(reason)) return reason.toString('utf8');
    return String(reason);
  }
}
