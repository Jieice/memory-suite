// 服务URL管理 - 统一管理所有服务的URL
export class ServiceUrls {
  readonly managerPort: number;
  readonly memoryPort: number;
  readonly ttsPort: number;
  readonly live2dPort: number;
  readonly danmakuPort: number;
  
  readonly webManagerUrl: string;
  readonly memoryUniverseUrl: string;
  readonly chatUrl: string;
  readonly subtitleUrl: string;
  readonly ttsUrl: string;
  readonly audioPlayUrl: string;
  
  constructor(
    private customChatUrl?: string,
    private customSubtitleUrl?: string,
    private customTtsUrl?: string,
    private customAudioPlayUrl?: string
  ) {
    // 端口配置 - 统一使用 .env 中的配置
    this.managerPort = Number(process.env.MANAGER_PORT) || 8080;
    this.memoryPort = Number(process.env.MEMORY_UNIVERSE_PORT) || 4005;
    this.ttsPort = Number(process.env.TTS_SERVICE_PORT) || 4014;
    this.live2dPort = Number(process.env.LIVE2D_SERVICE_PORT) || 4002;
    this.danmakuPort = Number(process.env.DANMAKU_SERVICE_PORT) || 4003;
    
    // Web Manager URL (服务编排层)
    this.webManagerUrl = process.env.MANAGER_URL || `http://127.0.0.1:${this.managerPort}`;
    
    // Memory Universe URL
    this.memoryUniverseUrl = process.env.MEMORY_UNIVERSE_URL || `http://127.0.0.1:${this.memoryPort}`;
    
    // API URLs - 统一通过 Manager 编排
    this.chatUrl = customChatUrl || `${this.webManagerUrl}/api/chat`;
    this.subtitleUrl = customSubtitleUrl || `http://127.0.0.1:${this.live2dPort}/api/subtitle`;
    this.ttsUrl = customTtsUrl || `http://127.0.0.1:${this.ttsPort}/api/tts`;
    this.audioPlayUrl = customAudioPlayUrl || `http://127.0.0.1:${this.live2dPort}/audio/play`;
  }
  
  /**
   * 获取健康检查URL - 统一使用 /health 端点
   */
  getHealthCheckUrl(service: 'manager' | 'memory' | 'tts' | 'live2d' | 'danmaku'): string {
    const urls: Record<string, string> = {
      manager: `${this.webManagerUrl}/health`,
      memory: `${this.memoryUniverseUrl}/health`,
      tts: `http://127.0.0.1:${this.ttsPort}/health`,
      live2d: `http://127.0.0.1:${this.live2dPort}/health`,
      danmaku: `http://127.0.0.1:${this.danmakuPort}/health`
    };
    return urls[service];
  }
  
  getProactiveCheckUrl(): string {
    return `${this.webManagerUrl}/api/proactive/check`;
  }
  
  /**
   * 获取所有服务的健康检查URL
   */
  getAllHealthUrls(): Record<string, string> {
    return {
      manager: this.getHealthCheckUrl('manager'),
      memory: this.getHealthCheckUrl('memory'),
      tts: this.getHealthCheckUrl('tts'),
      live2d: this.getHealthCheckUrl('live2d'),
      danmaku: this.getHealthCheckUrl('danmaku')
    };
  }
}
