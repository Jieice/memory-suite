// 消息队列 - 防止高峰期消息丢失，支持持久化
import fs from 'fs';
import path from 'path';

export interface QueuedMessage {
  uname: string;
  message: string;
  type: 'danmaku' | 'gift' | 'superchat' | 'guard';
  msgId: string;
  traceId?: string;  // 追踪ID
  priority?: number;
  timestamp?: number;
}

const QUEUE_PERSIST_PATH = path.resolve(process.cwd(), 'data/message-queue.json');

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private processing: boolean = false;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty: boolean = false;
  
  constructor(
    private maxSize: number = 50,
    private processor: (msg: QueuedMessage) => Promise<void>,
    private logger: (...args: any[]) => void,
    private persistEnabled: boolean = true
  ) {
    // 启动时恢复队列
    if (this.persistEnabled) {
      this.loadFromDisk();
      // 定时持久化（每5秒）
      this.persistTimer = setInterval(() => this.saveToDisk(), 5000);
    }
  }
  
  async enqueue(message: QueuedMessage): Promise<void> {
    // 添加时间戳
    message.timestamp = message.timestamp || Date.now();
    
    if (this.queue.length >= this.maxSize) {
      const dropped = this.queue.shift();
      this.logger(`⚠️ 消息队列满，丢弃最旧消息: [${dropped?.uname}] ${dropped?.message.substring(0, 20)}`);
    }
    
    this.queue.push(message);
    this.dirty = true;
    
    if (!this.processing) {
      this.process();
    }
  }
  
  private async process(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const msg = this.queue.shift();
      if (!msg) continue;
      
      this.dirty = true;
      
      try {
        await this.processor(msg);
      } catch (err: any) {
        this.logger(`❌ 消息处理失败: ${err.message}`);
        // 处理失败的消息可以选择重新入队（可选）
        // this.queue.unshift(msg);
      }
    }
    
    this.processing = false;
    
    // 处理完成后立即持久化
    if (this.persistEnabled && this.dirty) {
      this.saveToDisk();
    }
  }
  
  /**
   * 从磁盘加载队列
   */
  private loadFromDisk(): void {
    try {
      if (fs.existsSync(QUEUE_PERSIST_PATH)) {
        const data = fs.readFileSync(QUEUE_PERSIST_PATH, 'utf8');
        const saved = JSON.parse(data) as QueuedMessage[];
        
        // 过滤掉超过1小时的旧消息
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        this.queue = saved.filter(msg => (msg.timestamp || 0) > oneHourAgo);
        
        if (this.queue.length > 0) {
          this.logger(`📥 从磁盘恢复 ${this.queue.length} 条消息`);
          // 恢复后开始处理
          if (!this.processing) {
            this.process();
          }
        }
      }
    } catch (err: any) {
      this.logger(`⚠️ 加载队列失败: ${err.message}`);
    }
  }
  
  /**
   * 持久化队列到磁盘
   */
  private saveToDisk(): void {
    if (!this.dirty) return;
    
    try {
      // 确保目录存在
      const dir = path.dirname(QUEUE_PERSIST_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(QUEUE_PERSIST_PATH, JSON.stringify(this.queue), 'utf8');
      this.dirty = false;
    } catch (err: any) {
      this.logger(`⚠️ 持久化队列失败: ${err.message}`);
    }
  }
  
  /**
   * 关闭时保存
   */
  shutdown(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.persistEnabled) {
      this.saveToDisk();
    }
  }
  
  getQueueLength(): number {
    return this.queue.length;
  }
  
  isProcessing(): boolean {
    return this.processing;
  }
  
  /**
   * 获取队列统计
   */
  getStats(): { length: number; processing: boolean; oldestTimestamp: number | null } {
    return {
      length: this.queue.length,
      processing: this.processing,
      oldestTimestamp: this.queue.length > 0 ? (this.queue[0].timestamp || null) : null
    };
  }
}
