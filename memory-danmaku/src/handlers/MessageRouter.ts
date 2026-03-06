// 消息路由器 - 统一处理所有类型的消息
import { QueuedMessage } from '../queue/MessageQueue.js';
import { MemoryUniverseClient } from '../integration/MemoryUniverseClient.js';
import { TTSOrchestrator, ResponseContext } from '../output/TTSOrchestrator.js';

// 生成追踪ID
function generateTraceId(source: string = 'dm'): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${source}_${timestamp}_${random}`;
}

export interface StatusBroadcaster {
  broadcastStatus(status: string, extra?: string): void;
}

// 弹幕风格学习客户端（带清洗和采样）
class DanmakuStyleLearningClient {
  private buffer: Array<{ content: string; userId: string; username: string }> = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private seenContent: Set<string> = new Set();  // 去重
  private totalReceived = 0;
  private totalAccepted = 0;
  
  // 配置参数
  private readonly BUFFER_SIZE = 100;           // 缓冲区大小（100条才发送）
  private readonly FLUSH_INTERVAL = 60000;      // 刷新间隔（1分钟）
  private readonly SAMPLE_RATE = 0.3;           // 采样率（30%）
  private readonly MIN_LENGTH = 2;              // 最短长度
  private readonly MAX_LENGTH = 50;             // 最长长度
  private readonly DEDUP_CACHE_SIZE = 1000;     // 去重缓存大小
  
  // 排除模式（广告、无意义内容、敏感平台名）
  private readonly EXCLUDE_PATTERNS = [
    /关注.*直播/i,
    /点赞.*投币/i,
    /抽奖/,
    /红包/,
    /^\d+$/,                    // 纯数字
    /^[.。，,!！?？]+$/,         // 纯标点
    /^(.)\1{3,}$/,              // 重复字符 aaaa
    /https?:\/\//,              // 链接
    /[QqVv]群/,                 // QQ群
    /加群/,
    /私聊/,
    /代[打刷]/,
    /出售/,
    /便宜/,
    // 竞品平台名（直播间敏感词）
    /抖音/i,
    /douyin/i,
    /tiktok/i,
    /快手/i,
    /kuaishou/i,
    /虎牙/i,
    /huya/i,
    /斗鱼/i,
    /douyu/i,
    /微博/i,
    /weibo/i,
    /知乎/i,
    /zhihu/i,
    /小红书/i,
    /xiaohongshu/i,
    /youtube/i,
    /油管/i,
    /twitch/i,
    /twitter/i,
    /推特/i,
    /ins(tagram)?/i,
    /facebook/i,
    /脸书/i,
  ];
  
  // 有价值的模式（优先学习）
  private readonly VALUABLE_PATTERNS = [
    /^[哈嘿呵]{2,}$/,           // 笑声
    /^[6６]+$/,                  // 666
    /yyds/i,
    /绝绝子/,
    /笑死/,
    /破防/,
    /离谱/,
    /好家伙/,
    /确实/,
    /牛/,
    /太[强牛猛]了/,
    /[?？]{2,}/,                // 多个问号
    /[!！]{2,}/,                // 多个感叹号
  ];
  
  constructor(
    private apiUrl: string,
    private logger: (...args: any[]) => void
  ) {
    // 启动定时刷新
    this.flushTimer = setInterval(() => this.flush(), this.FLUSH_INTERVAL);
  }
  
  addSample(content: string, userId: string, username: string): void {
    this.totalReceived++;
    
    // 1. 清洗检查
    if (!this.shouldLearn(content)) return;
    
    // 2. 去重检查
    const contentKey = content.toLowerCase().trim();
    if (this.seenContent.has(contentKey)) return;
    
    // 3. 采样（有价值的内容100%采样，普通内容按采样率）
    const isValuable = this.VALUABLE_PATTERNS.some(p => p.test(content));
    if (!isValuable && Math.random() > this.SAMPLE_RATE) return;
    
    // 通过所有检查，加入缓冲区
    this.buffer.push({ content, userId, username });
    this.totalAccepted++;
    
    // 更新去重缓存
    this.seenContent.add(contentKey);
    if (this.seenContent.size > this.DEDUP_CACHE_SIZE) {
      // 清理一半缓存
      const entries = Array.from(this.seenContent);
      this.seenContent = new Set(entries.slice(entries.length / 2));
    }
    
    // 缓冲区满了就发送
    if (this.buffer.length >= this.BUFFER_SIZE) {
      this.flush();
    }
  }
  
  /**
   * 清洗检查：是否应该学习这条弹幕
   */
  private shouldLearn(content: string): boolean {
    const trimmed = content.trim();
    
    // 长度检查
    if (trimmed.length < this.MIN_LENGTH || trimmed.length > this.MAX_LENGTH) {
      return false;
    }
    
    // 排除模式检查
    for (const pattern of this.EXCLUDE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return false;
      }
    }
    
    return true;
  }
  
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    
    const samples = [...this.buffer];
    this.buffer = [];
    
    try {
      const response = await fetch(`${this.apiUrl}/api/danmaku-style/learn/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ samples })
      });
      
      if (response.ok) {
        const acceptRate = this.totalReceived > 0 
          ? ((this.totalAccepted / this.totalReceived) * 100).toFixed(1) 
          : '0';
        this.logger(`[弹幕学习] 已发送 ${samples.length} 条样本（采样率: ${acceptRate}%）`);
      }
    } catch (error) {
      // 静默失败，不影响主流程
      this.logger(`[弹幕学习] 发送失败，样本已丢弃`);
    }
  }
  
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush(); // 最后刷新一次
  }
  
  getStats(): { received: number; accepted: number; rate: string } {
    return {
      received: this.totalReceived,
      accepted: this.totalAccepted,
      rate: this.totalReceived > 0 
        ? ((this.totalAccepted / this.totalReceived) * 100).toFixed(1) + '%'
        : '0%'
    };
  }
}

export class MessageRouter {
  private busy: boolean = false;
  private lastMsgKey: string = '';
  private lastMsgTime: number = 0;
  private lastMessageTime: number = Date.now();
  private messageCount: number = 0;
  private styleLearner: DanmakuStyleLearningClient | null = null;
  
  constructor(
    private triggerPrefix: string,
    private rateLimitMs: number,
    private aiClient: MemoryUniverseClient,
    private ttsOrchestrator: TTSOrchestrator,
    private statusBroadcaster: StatusBroadcaster | null,
    private logger: (...args: any[]) => void,
    memoryUniverseUrl?: string
  ) {
    // 初始化弹幕风格学习客户端
    const universeUrl = memoryUniverseUrl || process.env.MEMORY_UNIVERSE_URL || 'http://localhost:4005';
    this.styleLearner = new DanmakuStyleLearningClient(universeUrl, logger);
    this.logger(`[弹幕学习] 已启用，目标: ${universeUrl}`);
  }
  
  async processMessage(msg: QueuedMessage): Promise<void> {
    this.lastMessageTime = Date.now();
    this.messageCount++;
    
    // 🆕 发送弹幕样本到风格学习器（所有弹幕都学习，不只是触发的）
    if (this.styleLearner && msg.message && msg.uname) {
      this.styleLearner.addSample(msg.message, msg.uname, msg.uname);
    }
    
    // 生成或使用已有的 traceId
    const traceId = msg.traceId || generateTraceId('dm');
    const logPrefix = `[${traceId}]`;
    
    const msgKey = `${msg.uname}-${msg.message}`;
    if (msgKey === this.lastMsgKey && Math.abs(Date.now() - this.lastMsgTime) < this.rateLimitMs) {
      return;
    }
    this.lastMsgKey = msgKey;
    this.lastMsgTime = Date.now();
    
    if (this.busy) {
      this.logger(`${logPrefix} 忙碌，忽略消息`, msg.message);
      return;
    }
    
    this.busy = true;
    this.logger(`${logPrefix} 开始处理${msg.type}消息: [${msg.uname}] ${msg.message}`);
    
    this.statusBroadcaster?.broadcastStatus('listening', `收到 ${msg.uname} 的消息`);
    
    try {
      await this.streamChatAndSubtitle(msg, traceId);
    } catch (error: any) {
      this.logger(`${logPrefix} [错误] 处理消息失败: ${error.message}`);
    } finally {
      this.busy = false;
      setTimeout(() => {
        this.statusBroadcaster?.broadcastStatus('idle', '等待互动中...');
      }, 3000);
    }
  }
  
  private async streamChatAndSubtitle(msg: QueuedMessage, traceId: string): Promise<void> {
    const logPrefix = `[${traceId}]`;
    this.logger(`${logPrefix} [流式处理器] 开始处理: [${msg.uname}] ${msg.message}`);
    
    try {
      this.statusBroadcaster?.broadcastStatus('thinking', '正在思考回复...');
      
      // 使用 SSE 流式获取 AI 回复，按句子切分后逐句送 TTS
      const sentenceDelimiters = /[。！？；~\n]/;
      let sentenceBuffer = '';
      let fullText = '';
      let sentenceIndex = 0;
      let firstTokenReceived = false;
      const startTime = Date.now();

      for await (const token of this.aiClient.getReplyStream(msg.uname, msg.message, traceId)) {
        if (!firstTokenReceived) {
          firstTokenReceived = true;
          const ttft = Date.now() - startTime;
          this.logger(`${logPrefix} [流式处理器] 首 token 到达: ${ttft}ms`);
          this.statusBroadcaster?.broadcastStatus('responding', '正在回复...');
        }

        fullText += token;
        sentenceBuffer += token;

        // 检查是否有完整句子可以切出
        const delimiterMatch = sentenceBuffer.match(sentenceDelimiters);
        if (delimiterMatch && delimiterMatch.index !== undefined) {
          const splitPos = delimiterMatch.index + 1;
          const sentence = sentenceBuffer.slice(0, splitPos).trim();
          sentenceBuffer = sentenceBuffer.slice(splitPos);

          if (sentence.length > 0) {
            sentenceIndex++;
            this.logger(`${logPrefix} [流式TTS] 句子 #${sentenceIndex}: "${sentence}"`);
            // 逐句送 TTS（不等待完成，让 TTSOrchestrator 的锁机制管理顺序）
            await this.ttsOrchestrator.processWithSubtitle(
              sentence,
              `${msg.msgId}_s${sentenceIndex}`,
              traceId
            );
          }
        }
      }

      // 处理剩余的 buffer（最后一句可能没有标点结尾）
      const remaining = sentenceBuffer.trim();
      if (remaining.length > 0) {
        sentenceIndex++;
        this.logger(`${logPrefix} [流式TTS] 末句 #${sentenceIndex}: "${remaining}"`);
        await this.ttsOrchestrator.processWithSubtitle(
          remaining,
          `${msg.msgId}_s${sentenceIndex}`,
          traceId
        );
      }

      const totalTime = Date.now() - startTime;
      this.logger(`${logPrefix} [流式处理器] 完成: ${sentenceIndex} 句, ${fullText.length} 字, ${totalTime}ms`);
      
      if (!firstTokenReceived) {
        this.logger(`${logPrefix} [流式处理器] 未收到任何 token`);
      }
    } catch (error: any) {
      this.logger(`${logPrefix} [流式处理器] 处理失败: ${error.message}`);
    }
  }
  
  shouldProcessDanmaku(message: string): boolean {
    if (!this.triggerPrefix) return true;
    return message.startsWith(this.triggerPrefix);
  }
  
  isBusy(): boolean {
    return this.busy;
  }
  
  getLastMessageTime(): number {
    return this.lastMessageTime;
  }
  
  /**
   * 获取消息统计
   */
  getStats(): { messageCount: number; lastMessageTime: number; isBusy: boolean } {
    return {
      messageCount: this.messageCount,
      lastMessageTime: this.lastMessageTime,
      isBusy: this.busy
    };
  }
}
