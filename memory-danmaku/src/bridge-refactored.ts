// 重构后的弹幕桥接主入口 - 模块化架构
import { ConfigLoader } from './config/ConfigLoader.js';
import { ServiceUrls } from './config/ServiceUrls.js';
import { Logger } from './utils/Logger.js';
import { CircuitBreaker } from './utils/CircuitBreaker.js';
import { MessageQueue } from './queue/MessageQueue.js';
import { TTSManager } from './output/TTSManager.js';
import { SubtitleManager } from './output/SubtitleManager.js';
import { AudioPlayer } from './output/AudioPlayer.js';
import { TTSOrchestrator } from './output/TTSOrchestrator.js';
import { MemoryUniverseClient } from './integration/MemoryUniverseClient.js';
import { MessageRouter } from './handlers/MessageRouter.js';
import { DanmakuHandler } from './handlers/DanmakuHandler.js';
import { GiftHandler } from './handlers/GiftHandler.js';
import { SuperChatHandler } from './handlers/SuperChatHandler.js';
import { GuardHandler } from './handlers/GuardHandler.js';
import { BilibiliConnector } from './connection/BilibiliConnector.js';
import { WebSocketManager } from './connection/WebSocketManager.js';
import { ProactiveManager } from './integration/ProactiveManager.js';
import { DanmakuWebSocketServer } from './server/DanmakuWebSocketServer.js';
import { getWorldStateSyncer } from './stats/WorldStateSyncer.js';

class BridgeApplication {
  private logger = new Logger();
  private configLoader: ConfigLoader;
  private serviceUrls: ServiceUrls;
  private circuitBreaker: CircuitBreaker;
  private wsServer: DanmakuWebSocketServer;
  private messageRouter!: MessageRouter;
  private messageQueue!: MessageQueue;
  private wsManager!: WebSocketManager;
  private proactiveManager!: ProactiveManager;
  private bilibiliConnector!: BilibiliConnector;
  private worldStateSyncer = getWorldStateSyncer({}, (msg) => console.log(`[WorldState] ${msg}`));
  private retryTimer: NodeJS.Timeout | null = null;
  
  constructor() {
    // 加载配置
    this.configLoader = new ConfigLoader();
    const config = this.configLoader.load();
    
    // 初始化服务URL
    this.serviceUrls = new ServiceUrls(
      config.memoryChatUrl,
      config.live2dSubtitleUrl,
      config.ttsUrl,
      config.audioPlayUrl
    );
    
    // 初始化断路器
    this.circuitBreaker = new CircuitBreaker(3, 60000, this.logger.log.bind(this.logger));
    
    // 初始化WebSocket服务器
    this.wsServer = new DanmakuWebSocketServer(
      this.serviceUrls.danmakuPort,
      this.logger.log.bind(this.logger)
    );
    
    this.initializeComponents(config);
  }
  
  private initializeComponents(config: any): void {
    // 输出管理
    const ttsManager = new TTSManager(this.serviceUrls.ttsUrl, this.logger.log.bind(this.logger));
    const subtitleManager = new SubtitleManager(this.serviceUrls.subtitleUrl, this.logger.log.bind(this.logger));
    const audioPlayer = new AudioPlayer(this.serviceUrls.audioPlayUrl, this.logger.log.bind(this.logger));
    const ttsOrchestrator = new TTSOrchestrator(
      ttsManager,
      subtitleManager,
      audioPlayer,
      this.logger.log.bind(this.logger)
    );
    
    // AI集成
    const aiClient = new MemoryUniverseClient(
      this.serviceUrls.chatUrl,
      this.serviceUrls.webManagerUrl,
      this.circuitBreaker,
      this.logger.log.bind(this.logger)
    );
    
    // 消息路由
    this.messageRouter = new MessageRouter(
      config.triggerPrefix,
      config.rateLimitMs,
      aiClient,
      ttsOrchestrator,
      this.wsServer,
      this.logger.log.bind(this.logger)
    );
    
    // 消息队列
    this.messageQueue = new MessageQueue(
      50,
      (msg) => this.messageRouter.processMessage(msg),
      this.logger.log.bind(this.logger)
    );
    
    // 消息处理器
    const danmakuHandler = new DanmakuHandler(this.wsServer, this.logger.log.bind(this.logger));
    const giftHandler = new GiftHandler(this.wsServer, this.logger.log.bind(this.logger));
    const superChatHandler = new SuperChatHandler(this.wsServer, this.logger.log.bind(this.logger));
    const guardHandler = new GuardHandler(this.wsServer, this.logger.log.bind(this.logger));
    
    // B站连接器
    this.bilibiliConnector = new BilibiliConnector(
      config.danmakuCookie,
      config.danmakuType,
      config.webLocation,
      config.wRid,
      config.wts,
      this.logger.log.bind(this.logger)
    );
    
    // WebSocket管理器
    this.wsManager = new WebSocketManager(
      config.roomId,
      config.userUid,
      config.buvid,
      danmakuHandler,
      giftHandler,
      superChatHandler,
      guardHandler,
      this.messageQueue,
      (msg) => this.messageRouter.shouldProcessDanmaku(msg),
      () => this.scheduleRetry(5000),
      () => this.scheduleRetry(5000),
      this.logger.log.bind(this.logger)
    );
    
    // 主动行为管理器
    this.proactiveManager = new ProactiveManager(
      this.serviceUrls.webManagerUrl,
      config.userId,
      () => this.messageRouter.getLastMessageTime(),
      () => this.messageRouter.isBusy(),
      () => aiClient.checkServiceAvailability(),
      (content, msgId, traceId) => ttsOrchestrator.processWithSubtitle(content, msgId, traceId),
      this.logger.log.bind(this.logger)
    );
  }
  
  async start(): Promise<void> {
    this.logger.log('🚀 Bootstrap 启动...');
    
    try {
      // Step 1: 启动WebSocket服务器
      this.logger.log('📍 Step 1: 启动WebSocket服务器...');
      this.wsServer.listen();
      this.logger.log('✅ WebSocket服务器启动完成');
      
      // Step 2: 获取房间信息
      this.logger.log('📍 Step 2: 获取房间信息...');
      const config = this.configLoader.get();
      const roomInfo = await this.bilibiliConnector.getRoomInit(config.roomId);
      this.logger.log('✅ 房间信息获取成功:', roomInfo);
      
      // 更新房间ID
      if (roomInfo.roomId !== config.roomId) {
        this.configLoader.save({ roomId: roomInfo.roomId });
      }
      
      if (roomInfo.live_status !== 1) {
        this.logger.log(`房间尚未正式开播 (live_status=${roomInfo.live_status}), 将继续检查弹幕状态`);
      }
      
      // Step 3: 启动弹幕连接
      this.logger.log('📍 Step 3: 启动弹幕连接...');
      await this.startBridge();
      this.logger.log('✅ 弹幕连接启动完成');
      
      // Step 4: 启动主动行为检测
      this.logger.log('📍 Step 4: 启动 NN 主动行为检测...');
      this.proactiveManager.startChecking(5000);
      
      this.logger.log('📍 Step 5: 启动 WorldState 同步...');
      this.worldStateSyncer.start();
      
      this.logger.log('✅ Bootstrap 完成！');
    } catch (error: any) {
      this.logger.error('❌ Bootstrap 失败:', error.message);
      this.logger.error('❌ 错误堆栈:', error.stack);
    }
  }
  
  private async startBridge(): Promise<void> {
    if (this.wsManager.isConnected()) {
      this.logger.log('连接已建立，跳过重复启动');
      return;
    }
    
    try {
      await this.circuitBreaker.execute(
        async () => {
          const config = this.configLoader.get();
          const danmuData = await this.bilibiliConnector.fetchDanmuInfo(config.roomId);
          
          if (danmuData.code !== 0) {
            throw new Error(`getDanmuInfo 返回异常 code=${danmuData.code}`);
          }
          
          if (!danmuData.data) {
            throw new Error('getDanmuInfo 未返回数据');
          }
          
          this.wsManager.connect(danmuData.data);
        },
        async () => {
          this.logger.log('🚫 弹幕连接失败，进入离线模式');
          this.logger.log('💡 可以手动发送消息到 /api/chat 进行测试');
          setTimeout(() => this.startBridge(), 30000);
        }
      );
    } catch (err: any) {
      this.logger.error('拉取弹幕信息失败:', err.message || err);
      this.scheduleRetry(5000);
    }
  }
  
  private scheduleRetry(delay: number = 5000): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.logger.log(`📍 ${delay / 1000}秒后重试连接...`);
    this.retryTimer = setTimeout(() => this.startBridge(), delay);
  }
  
  shutdown(): void {
    this.logger.log('正在关闭...');
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.wsManager.close();
    this.worldStateSyncer.stop();
    process.exit(0);
  }
}

// 启动应用
const app = new BridgeApplication();
app.start();

// 信号处理
process.stdin.resume();
process.on('SIGINT', () => app.shutdown());
