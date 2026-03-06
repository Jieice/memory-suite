// Memory Universe API客户端 - 通过Web Manager服务编排层
import { CircuitBreaker } from '../utils/CircuitBreaker.js';
import { withTimeout } from '../utils/TimeoutHelper.js';
import { VoiceParams } from '../output/TTSManager.js';

export interface ChatRequest {
  userId: string;
  userName: string;
  message: string;
  text: string;
  traceId?: string;
}

export interface ChatResponse {
  success: boolean;
  text?: string;
  response?: string;
  error?: string;
  // 新增：情绪和音色控制
  emotion?: string;
  voiceParams?: VoiceParams;
  metadata?: {
    decisionTime?: number;
    generationTime?: number;
    totalTime?: number;
    fallbackUsed?: boolean;
    traceId?: string;
  };
}

/**
 * AI 回复结果 - 包含文本和音色控制
 */
export interface AIReplyResult {
  text: string;
  emotion?: string;
  voiceParams?: VoiceParams;
}

export class MemoryUniverseClient {
  private serviceAvailable: boolean = true;
  private lastServiceCheckTime: number = 0;
  private readonly SERVICE_CHECK_INTERVAL = 30000; // 30秒
  private readonly CHAT_TIMEOUT_MS: number = Number(process.env.WEB_MANAGER_CHAT_TIMEOUT_MS || 30000);
  
  constructor(
    private chatUrl: string,
    private webManagerUrl: string,
    private breaker: CircuitBreaker,
    private logger: (...args: any[]) => void,
    private fallbackReply: string = '请告诉创造者，我的ai出现问题了'
  ) {}
  
  /**
   * 获取 AI 回复（完整版，包含情绪和音色参数）
   */
  async getReplyFull(userId: string, message: string, traceId?: string): Promise<AIReplyResult> {
    const logPrefix = traceId ? `[${traceId}]` : '';
    this.logger(`${logPrefix} [AI回复] 请求: userId=${userId}, message=${message}`);
    
    // 检查服务可用性
    const isAvailable = await this.checkServiceAvailability();
    if (!isAvailable) {
      this.logger(`${logPrefix} [AI回复] ⚠️ Web Manager 服务不可用，使用降级方案`);
      return { text: this.fallbackReply };
    }
    
    try {
      const result = await this.breaker.execute(
        async () => {
          this.logger(`${logPrefix} [AI回复] 正在调用 Web Manager API: ${this.chatUrl}`);
          
          // 构建请求头，包含 traceId
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (traceId) {
            headers['x-trace-id'] = traceId;
            headers['x-trace-source'] = 'danmaku';
          }
          
          const resp = await withTimeout(
            fetch(this.chatUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify({ 
                userId, 
                userName: userId, 
                message,
                text: message,
                traceId
              })
            }),
            this.CHAT_TIMEOUT_MS,
            'Web Manager Chat'
          );
          
          this.logger(`${logPrefix} [AI回复] API响应状态: ${resp.status}`);
          
          if (!resp.ok) {
            const errorText = await resp.text();
            this.logger(`${logPrefix} [AI回复] API错误响应: ${errorText}`);
            throw new Error(`Web Manager API错误: ${resp.status}`);
          }
          
          const data: any = await resp.json();
          this.logger(`${logPrefix} [AI回复] API响应数据: ${JSON.stringify(data).substring(0, 200)}`);
          
          if (!data.success) {
            if (data.error?.includes('CIRCUIT_BREAKER_OPEN')) {
              this.logger(`${logPrefix} [AI回复] ⚠️ 服务断路器已打开，使用降级方案`);
              return { text: this.fallbackReply };
            }
            if (data.error?.includes('SERVICE_UNAVAILABLE')) {
              this.logger(`${logPrefix} [AI回复] ⚠️ 后端服务不可用，使用降级方案`);
              this.serviceAvailable = false;
              return { text: this.fallbackReply };
            }
            throw new Error(`AI未返回成功响应: ${data.error || 'unknown error'}`);
          }
          
          const responseText = data.text || data.response;
          if (!responseText) {
            throw new Error(`AI未返回有效回复`);
          }
          
          if (data.metadata) {
            this.logger(`${logPrefix} [AI回复] 元数据: 决策=${data.metadata.decisionTime}ms, 生成=${data.metadata.generationTime}ms, 总计=${data.metadata.totalTime}ms`);
          }
          
          // 提取情绪和音色参数
          const emotion = data.emotion || 'neutral';
          const voiceParams = data.voiceParams || data.voice_params;
          
          if (emotion !== 'neutral' || voiceParams) {
            this.logger(`${logPrefix} [AI回复] 情绪: ${emotion}, 音色参数: ${JSON.stringify(voiceParams || {})}`);
          }
          
          this.logger(`${logPrefix} [AI回复] ✅ 收到回复: "${responseText.substring(0, 50)}..."`);
          
          return {
            text: responseText,
            emotion,
            voiceParams
          };
        },
        async () => {
          this.logger(`${logPrefix} [AI回复] ⚠️ 使用降级方案: "${this.fallbackReply}"`);
          return { text: this.fallbackReply };
        }
      );
      
      return result || { text: this.fallbackReply };
    } catch (error: any) {
      this.logger(`${logPrefix} [AI回复] ❌ 获取失败: ${error.message}`);
      return { text: this.fallbackReply };
    }
  }
  
  /**
   * 获取 AI 回复（兼容旧接口，只返回文本）
   */
  async getReply(userId: string, message: string, traceId?: string): Promise<string> {
    const result = await this.getReplyFull(userId, message, traceId);
    return result.text;
  }

  /**
   * SSE 流式获取 AI 回复，逐 token yield
   * 降级：SSE 失败时 fallback 到 getReplyFull 一次性返回
   */
  async *getReplyStream(userId: string, message: string, traceId?: string): AsyncGenerator<string> {
    const logPrefix = traceId ? `[${traceId}]` : '';
    const streamUrl = this.chatUrl.replace(/\/api\/chat\/?$/, '/api/chat/stream');

    const isAvailable = await this.checkServiceAvailability();
    if (!isAvailable) {
      this.logger(`${logPrefix} [AI流式] 服务不可用，降级到非流式`);
      const result = await this.getReplyFull(userId, message, traceId);
      if (result.text) yield result.text;
      return;
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (traceId) {
        headers['x-trace-id'] = traceId;
        headers['x-trace-source'] = 'danmaku';
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.CHAT_TIMEOUT_MS);

      const resp = await fetch(streamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userId, userName: userId, message, text: message, traceId }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        clearTimeout(timeoutId);
        this.logger(`${logPrefix} [AI流式] SSE 请求失败 (${resp.status})，降级到非流式`);
        const result = await this.getReplyFull(userId, message, traceId);
        if (result.text) yield result.text;
        return;
      }

      this.logger(`${logPrefix} [AI流式] SSE 连接建立`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (!trimmed.startsWith('data: ')) continue;

            const data = trimmed.slice(6);
            if (data === '[DONE]') {
              clearTimeout(timeoutId);
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const token = parsed.token || parsed.text || parsed.content;
              if (token) yield token;
            } catch {
              // Skip malformed chunks
            }
          }
        }
      } finally {
        reader.releaseLock();
        clearTimeout(timeoutId);
      }

      this.logger(`${logPrefix} [AI流式] SSE 流结束`);
    } catch (error: any) {
      this.logger(`${logPrefix} [AI流式] SSE 失败: ${error.message}，降级到非流式`);
      const result = await this.getReplyFull(userId, message, traceId);
      if (result.text) yield result.text;
    }
  }
  
  async checkServiceAvailability(maxRetries: number = 3): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastServiceCheckTime < this.SERVICE_CHECK_INTERVAL) {
      return this.serviceAvailable;
    }
    
    this.lastServiceCheckTime = now;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 使用统一的 /health 端点
        const healthUrl = `${this.webManagerUrl}/health`;
        const response = await withTimeout(
          fetch(healthUrl, { method: 'GET' }),
          5000,
          'Service Health Check'
        );
        
        if (response.ok) {
          const data: any = await response.json();
          this.serviceAvailable = data.status === 'healthy' || data.status === 'degraded';
          
          if (!this.serviceAvailable) {
            this.logger(`⚠️ 服务状态异常: ${data.status}`);
          } else {
            this.logger(`✅ 服务状态正常: ${data.status}`);
          }
          
          return this.serviceAvailable;
        }
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      } catch (error: any) {
        this.logger(`⚠️ Web Manager 不可用 (第 ${attempt}/${maxRetries} 次): ${error.message}`);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    
    this.serviceAvailable = false;
    return false;
  }
}
