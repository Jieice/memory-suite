// 配置加载器 - 负责加载和验证配置
import fs from 'fs';
import path from 'path';
import { config as dotenvConfig } from 'dotenv';

export interface BridgeConfig {
  roomId: number;
  triggerPrefix: string;
  rateLimitMs: number;
  userId: string;
  danmakuCookie: string;
  userUid: number;
  buvid: string;
  danmakuType: number;
  webLocation: string;
  wRid?: string;
  wts?: number;
  memoryChatUrl?: string;
  live2dSubtitleUrl?: string;
  ttsUrl?: string;
  audioPlayUrl?: string;
}

export class ConfigLoader {
  private config: BridgeConfig | null = null;
  
  constructor(private configPath: string = path.join(process.cwd(), 'config.json')) {
    // 加载环境变量
    dotenvConfig({ path: path.join(process.cwd(), '../.env') });
  }
  
  load(): BridgeConfig {
    if (this.config) return this.config;
    
    const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    
    this.config = {
      roomId: Number(cfg.roomId) || 0,
      triggerPrefix: typeof cfg.triggerPrefix === 'string' ? cfg.triggerPrefix : '',
      rateLimitMs: Number(cfg.rateLimitMs) || 2000,
      userId: cfg.userId || 'danmaku',
      danmakuCookie: cfg.danmakuCookie || cfg.cookie || '',
      userUid: Number(cfg.userUid || cfg.uid || cfg.userIdNumber || 0) || 0,
      buvid: cfg.buvid || '',
      danmakuType: Number(cfg.danmakuType ?? 0),
      webLocation: cfg.webLocation || '444.8',
      wRid: cfg.wRid || '',
      wts: Number(cfg.wts || 0),
      memoryChatUrl: cfg.memoryChatUrl,
      live2dSubtitleUrl: cfg.live2dSubtitleUrl,
      ttsUrl: cfg.ttsUrl,
      audioPlayUrl: cfg.audioPlayUrl
    };
    
    this.validate();
    return this.config;
  }
  
  validate(): void {
    if (!this.config) throw new Error('配置未加载');
    
    if (!this.config.roomId) {
      throw new Error('请在 config.json 中设置有效的 roomId');
    }
    
    if (!this.config.danmakuCookie) {
      throw new Error('请在 config.json 中填入完整的 danmakuCookie（SESSDATA/DedeUserID/bili_jct）');
    }
  }
  
  save(updates: Partial<BridgeConfig>): void {
    if (!this.config) throw new Error('配置未加载');
    
    this.config = { ...this.config, ...updates };
    const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    Object.assign(cfg, updates);
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2));
  }
  
  get(): BridgeConfig {
    if (!this.config) throw new Error('配置未加载，请先调用 load()');
    return this.config;
  }
}
