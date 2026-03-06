/**
 * LLM Fallback Handler
 * Handles graceful degradation when LLM services fail
 * Supports both DeepSeek API and Local LLM with fallback logic
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import {
  FallbackManager,
  getGlobalFallbackManager,
} from '../../../shared/FallbackManager';
import {
  FallbackResponse,
  createFallbackResponse,
} from '../../../shared/FallbackTemplate';
import { runWithLLMCircuitBreaker } from '../../../shared/CircuitBreakerClient';
import {
  createErrorContext,
} from '../../../shared/ErrorCategories';
import { getGlobalLogger } from '../../../shared/FallbackLogger';
import { getLocalLLMService, LLMConfig } from './LocalLLMService';

export interface LLMRequest {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  timeout?: number;
  preferCloud?: boolean;
  forceProvider?: 'local' | 'deepseek';
  strictProvider?: boolean;
}

export interface LLMResult {
  success: boolean;
  text?: string;
  error?: string;
  fallbackReason?: string;
  provider?: 'local' | 'deepseek';
}

/**
 * LLM Fallback Handler
 */
export class LLMFallbackHandler {
  private fallbackManager: FallbackManager;
  private logger = getGlobalLogger();
  private deepseekBaseUrl: string;
  private deepseekApiKey: string;
  private useLocalLLM: boolean;
  private deepseekModel: string;
  private localLLMEngine: string;
  private localCppService = null as ReturnType<typeof getLocalLLMService> | null;
  private localCppConfig: LLMConfig | null = null;
  private llmWarmupStart = Date.now();
  private llmWarmupWindowMs: number;
  private llmWarmupLogged = false;
  private llmWarmupDone = false;
  private cloudFirst: boolean;
  private cloudTimeoutMs: number;
  private localFallback: boolean;

  constructor() {
    this.fallbackManager = getGlobalFallbackManager();
    this.deepseekBaseUrl =
      process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    this.deepseekApiKey = process.env.DEEPSEEK_API_KEY || '';
    this.useLocalLLM = process.env.USE_LOCAL_LLM === 'true';
    this.deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    this.localLLMEngine = (process.env.LOCAL_LLM_ENGINE || 'cpp').toLowerCase();
    const warmupRaw =
      process.env.LLM_WARMUP_WINDOW_MS ||
      process.env.LOCAL_LLM_WARMUP_WINDOW_MS ||
      '60000';
    const parsedWarmup = parseInt(warmupRaw, 10);
    this.llmWarmupWindowMs = Number.isNaN(parsedWarmup) ? 60000 : parsedWarmup;
    this.cloudFirst = process.env.LLM_CLOUD_FIRST === 'true';
    this.cloudTimeoutMs = Math.max(1000, parseInt(process.env.LLM_CLOUD_TIMEOUT_MS || '2000', 10) || 2000);
    this.localFallback = process.env.LLM_LOCAL_FALLBACK !== 'false';
    this.cloudRetryMs = Math.max(500, parseInt(process.env.LLM_CLOUD_RETRY_MS || '1000', 10) || 1000);
    this.localMaxTimeMs = Math.max(500, parseInt(process.env.LLM_LOCAL_MAX_TIME_MS || '1500', 10) || 1500);
    const budgetRaw = process.env.LLM_LOCAL_FIRST_BUDGET_MS;
    const budgetParsed = budgetRaw ? parseInt(budgetRaw, 10) : NaN;
    this.localFirstBudgetMs = Math.max(
      0,
      !Number.isNaN(budgetParsed) ? budgetParsed : this.localMaxTimeMs
    );
    this.cloudAfterLocalTimeoutMs = Math.max(
      1000,
      parseInt(process.env.LLM_CLOUD_AFTER_LOCAL_TIMEOUT_MS || String(this.cloudTimeoutMs), 10) || this.cloudTimeoutMs
    );
    this.raceMode = process.env.LLM_RACE_MODE === 'true';
    this.raceLocalDelayMs = Math.max(0, parseInt(process.env.LLM_RACE_LOCAL_DELAY_MS || '300', 10) || 300);
    this.preferLocal = process.env.LLM_PREFER_LOCAL === 'true';
  }

  private cloudRetryMs: number;
  private localMaxTimeMs: number;
  private localFirstBudgetMs: number;
  private cloudAfterLocalTimeoutMs: number;
  private raceMode: boolean;
  private raceLocalDelayMs: number;
  private preferLocal: boolean;

  /**
   * Generate response with fallback handling
   */
  async generateResponse(request: LLMRequest): Promise<LLMResult | FallbackResponse> {
    // FORCE CLOUD FIRST: Override local preference to avoid timeout
    if (this.cloudFirst && this.deepseekApiKey) {
      if (request.forceProvider === 'local') {
        console.warn('[LLM] Overriding forceProvider=local -> deepseek per CloudFirst policy');
      }
      request.forceProvider = 'deepseek';
      request.preferCloud = true;
    }
    const cppTimeout = parseInt(process.env.LOCAL_LLM_TIMEOUT_MS || '60000', 10);
    const defaultTimeout = this.isCppLocalLLM()
      ? (Number.isNaN(cppTimeout) ? 60000 : cppTimeout)
      : 15000;
    const timeout = request.timeout || defaultTimeout;

    const forceProvider = request.forceProvider;
    const preferCloud = request.preferCloud === true;
    const strictProvider = request.strictProvider === true;

    let preferProvider: 'local' | 'deepseek';

    if (forceProvider) {
      preferProvider = forceProvider;
    } else if (preferCloud && this.deepseekApiKey) {
      preferProvider = 'deepseek';
    } else if (this.preferLocal && this.useLocalLLM) {
      preferProvider = 'local';
    } else if (this.cloudFirst && this.deepseekApiKey) {
      preferProvider = 'deepseek';
    } else if (this.useLocalLLM) {
      // Changed specific logic: Even if local is available, default to cloud unless explicitly preferred/forced
      // Old: preferProvider = 'local';
      preferProvider = 'deepseek';
    } else {
      preferProvider = 'deepseek';
    }

    return runWithLLMCircuitBreaker(async (): Promise<LLMResult | FallbackResponse> => {
      console.log(`[LLM] generateResponse: preferLocal=${this.preferLocal}, preferProvider=${preferProvider}, hasCloud=${!!this.deepseekApiKey}, hasLocal=${this.useLocalLLM}`);

      let primaryProvider: 'local' | 'deepseek' = preferProvider;
      let primaryTimeout = timeout;
      let localFirstFailed = false;
      let localFirstError: Error | null = null;

      if (preferProvider === 'local' && this.useLocalLLM) {
        const localFirstTimeout = Math.min(timeout, this.localFirstBudgetMs);
        console.log(`[LLM] Local-first preflight: budget=${localFirstTimeout}ms`);
        try {
          const localResult = await this.tryLocalLLM(request, localFirstTimeout);
          if (localResult.success && localResult.text) {
            console.log(`[LLM] Local-first succeeded in <=${localFirstTimeout}ms`);
            return localResult;
          }
          localFirstFailed = true;
          localFirstError = new Error(localResult.error || 'Local-first returned empty response');
          console.log(`[LLM] Local-first returned empty/failed: ${localFirstError.message}`);
        } catch (e) {
          localFirstFailed = true;
          localFirstError = e as Error;
          console.log(`[LLM] Local-first failed: ${localFirstError.message}`);
        }

        if (!strictProvider && this.deepseekApiKey) {
          primaryProvider = 'deepseek';
          primaryTimeout = Math.min(timeout, this.cloudAfterLocalTimeoutMs);
          console.log(`[LLM] Switching to cloud after local-first failure (timeout=${primaryTimeout}ms)`);
        }
      }

      if (this.raceMode && this.deepseekApiKey && this.useLocalLLM && !forceProvider && !strictProvider && !localFirstFailed) {
        console.log(`[LLM] Race mode: cloud vs local starting...`);
        const startTime = Date.now();

        const cloudPromise = this.tryDeepseekLLM(request, this.cloudTimeoutMs);
        const localPromise = (async () => {
          await new Promise(r => setTimeout(r, this.raceLocalDelayMs));
          if (!this.isCppLocalLLM()) return null;
          try {
            return await this.tryLocalLLM(request, this.localMaxTimeMs);
          } catch {
            return null;
          }
        })();

        try {
          const results = await Promise.allSettled([cloudPromise, localPromise]);
          const cloudResult = results[0].status === 'fulfilled' ? results[0].value : null;
          const localResult = results[1].status === 'fulfilled' ? results[1].value : null;

          if (cloudResult && cloudResult.success && cloudResult.text) {
            console.log(`[LLM] Race won by cloud in ${Date.now() - startTime}ms`);
            return cloudResult;
          }
          if (localResult && localResult.success && localResult.text) {
            console.log(`[LLM] Race won by local in ${Date.now() - startTime}ms`);
            return localResult;
          }
        } catch (e) {
          console.log(`[LLM] Race mode error: ${(e as Error).message}`);
        }
      }

      try {
        const cloudTimeout = this.cloudFirst ? this.cloudTimeoutMs : timeout;

        const primary = primaryProvider === 'local'
          ? (localFirstFailed
            ? (() => { throw (localFirstError || new Error('Local-first failed')); })()
            : await this.tryLocalLLM(request, timeout))
          : await this.tryDeepseekLLM(
            request,
            Math.min(localFirstFailed ? primaryTimeout : cloudTimeout, timeout)
          );

        if (primary.success && primary.text) {
          return primary;
        }

        throw new Error(primary.error || 'Primary LLM returned empty response');
      } catch (error) {
        const err = error as Error;
        const context = createErrorContext('LLM', err);

        this.logger.logFromContext(
          context,
          `Primary LLM failed: ${err.message}`
        );

        if (strictProvider || !this.localFallback) {
          if (err.message === 'LLM_WARMUP') {
            return this.getFallbackResponse('LLM_WARMUP', err);
          }
          return this.getFallbackResponse('LLM_UNAVAILABLE', err);
        }

        try {
          const secondaryProvider: 'local' | 'deepseek' = primaryProvider === 'local' ? 'deepseek' : 'local';
          const secondaryTimeout = secondaryProvider === 'deepseek'
            ? Math.min(localFirstFailed ? this.cloudAfterLocalTimeoutMs : timeout, timeout)
            : timeout;
          const secondary = secondaryProvider === 'deepseek'
            ? await this.tryDeepseekLLM(request, secondaryTimeout)
            : (localFirstFailed
              ? (() => { throw (localFirstError || new Error('Local LLM unavailable after local-first failure')); })()
              : await this.tryLocalLLM(request, secondaryTimeout));

          if (secondary.success && secondary.text) {
            console.log(`[LLM] Fallback to ${secondaryProvider} succeeded`);
            return secondary;
          }

          throw new Error(secondary.error || 'Secondary LLM returned empty response');
        } catch (secondaryError) {
          const err2 = secondaryError as Error;
          const context2 = createErrorContext('LLM', err2);

          this.logger.logFromContext(
            context2,
            `Secondary LLM also failed: ${err2.message}`
          );

          return this.getFallbackResponse('LLM_UNAVAILABLE', err2);
        }
      }
    });
  }

  /**
   * Generate stream response with true SSE streaming
   * Cloud: uses tryDeepseekStream() for real token-by-token streaming
   * Local: uses localCppService.generateStream() for token-by-token streaming
   * Fallback: generateResponse() yields full text as single chunk
   */
  async *generateStream(request: LLMRequest): AsyncGenerator<string> {
    const forceProvider = request.forceProvider;
    const preferCloud = request.preferCloud === true;
    const strictProvider = request.strictProvider === true;
    const preferLocal = request.preferCloud === false && this.preferLocal && this.useLocalLLM;
    const cloudAllowed = forceProvider !== 'local' && !preferLocal;

    console.log(`[LLM] generateStream called: raceMode=${this.raceMode}, hasCloud=${!!this.deepseekApiKey}, hasLocal=${this.useLocalLLM}, forceProvider=${forceProvider || 'none'}, preferCloud=${preferCloud}, preferLocal=${preferLocal}, strictProvider=${strictProvider}`);

    // Race mode: cloud SSE stream vs local stream, first token wins
    if (this.raceMode && this.deepseekApiKey && this.useLocalLLM && cloudAllowed && forceProvider !== 'deepseek' && !strictProvider) {
      console.log(`[LLM] Stream race mode starting...`);
      const startTime = Date.now();

      // Collect first-token from both providers concurrently
      const cloudTimeout = request.timeout || this.cloudTimeoutMs;
      const cloudGen = this.tryDeepseekStream(request, cloudTimeout);
      const localGen = this.isCppLocalLLM() ? this.getLocalStream(request) : null;

      // Race for first token
      type RaceResult = { source: 'cloud' | 'local'; firstToken: string; gen: AsyncGenerator<string> };
      const cloudRace = (async (): Promise<RaceResult | null> => {
        try {
          const first = await cloudGen.next();
          if (!first.done && first.value) {
            return { source: 'cloud', firstToken: first.value, gen: cloudGen };
          }
        } catch (e) {
          console.log(`[LLM] Race cloud failed: ${(e as Error).message}`);
        }
        return null;
      })();

      const localRace = localGen ? (async (): Promise<RaceResult | null> => {
        await new Promise(r => setTimeout(r, this.raceLocalDelayMs));
        try {
          const first = await localGen.next();
          if (!first.done && first.value) {
            return { source: 'local', firstToken: first.value, gen: localGen };
          }
        } catch (e) {
          console.log(`[LLM] Race local failed: ${(e as Error).message}`);
        }
        return null;
      })() : Promise.resolve(null);

      try {
        const winner = await Promise.race(
          [cloudRace, localRace].filter(Boolean) as Promise<RaceResult | null>[]
        );

        if (winner) {
          const elapsed = Date.now() - startTime;
          console.log(`[LLM] Stream race won by ${winner.source} in ${elapsed}ms (first token)`);
          yield winner.firstToken;
          for await (const chunk of winner.gen) {
            yield chunk;
          }
          return;
        }
      } catch (e) {
        console.log(`[LLM] Stream race error: ${(e as Error).message}`);
      }
    }

    // Cloud-first: true SSE streaming from DeepSeek
    if ((forceProvider === 'deepseek' || preferCloud || this.cloudFirst) && this.deepseekApiKey && cloudAllowed) {
      try {
        const cloudTimeout = forceProvider === 'deepseek'
          ? (request.timeout || this.cloudTimeoutMs)
          : (preferCloud ? (request.timeout || this.cloudTimeoutMs) : this.cloudTimeoutMs);
        console.log(`[LLM] Cloud SSE stream starting (timeout=${cloudTimeout}ms)...`);
        const streamStartTime = Date.now();
        let charCount = 0;
        for await (const token of this.tryDeepseekStream(request, cloudTimeout)) {
          charCount += token.length;
          yield token;
        }
        console.log(`[LLM] Cloud SSE stream done: ${charCount} chars in ${Date.now() - streamStartTime}ms`);
        return;
      } catch (error) {
        const err = error as Error;
        console.log(`[LLM] Cloud SSE stream failed: ${err.message}`);

        // Retry with non-streaming fallback
        if (this.cloudRetryMs > 0) {
          try {
            console.log(`[LLM] Retrying cloud non-stream with ${this.cloudRetryMs}ms timeout...`);
            const retryResult = await this.tryDeepseekLLM(request, this.cloudRetryMs);
            if (retryResult.success && retryResult.text) {
              console.log(`[LLM] Cloud retry succeeded (${retryResult.text.length} chars)`);
              yield retryResult.text;
              return;
            }
          } catch (retryError) {
            console.log(`[LLM] Cloud retry also failed, falling back to local`);
          }
        }
      }
    }

    // Local LLM: true token-by-token streaming
    if (this.useLocalLLM && this.isCppLocalLLM()) {
      try {
        const localGen = this.getLocalStream(request);
        const localStartTime = Date.now();
        let localCharCount = 0;
        for await (const chunk of localGen) {
          localCharCount += chunk.length;
          yield chunk;
          if (Date.now() - localStartTime > this.localMaxTimeMs) {
            console.log(`[LLM] Local stream timeout after ${this.localMaxTimeMs}ms, yielded ${localCharCount} chars`);
            return;
          }
        }
        if (localCharCount > 0) {
          console.log(`[LLM] Local stream done: ${localCharCount} chars in ${Date.now() - localStartTime}ms`);
          return;
        }
      } catch (error) {
        const err = error as Error;
        console.error(`[LLM] [LLMFallbackHandler] streaming_failed provider=local error=${err.message}`);
      }
    }

    // Ultimate fallback: non-streaming generateResponse, yield full text
    const result = await this.generateResponse(
      strictProvider
        ? request
        : { ...request, forceProvider: 'deepseek' }
    );
    if ((result as any).success && (result as LLMResult).text) {
      yield (result as LLMResult).text!;
    } else {
      const err = (result as Partial<LLMResult>).error || (result as Partial<FallbackResponse>).fallbackReason;
      throw new Error(`Stream fallback failed: ${err}`);
    }
  }

  /**
   * Try DeepSeek API
   */
  private async tryDeepseekLLM(
    request: LLMRequest,
    timeout: number
  ): Promise<LLMResult> {
    if (!this.deepseekApiKey) {
      throw new Error('DEEPSEEK_API_KEY not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const model = request.model || this.deepseekModel;
      const response = await axios.post(
        `${this.deepseekBaseUrl}/chat/completions`,
        {
          model,
          messages: [
            ...(request.systemPrompt
              ? [{ role: 'system', content: request.systemPrompt }]
              : []),
            { role: 'user', content: request.prompt },
          ],
          temperature: request.temperature || 0.7,
          top_p: request.topP || 0.9,
          max_tokens: request.maxTokens || 512,
        },
        {
          headers: {
            Authorization: `Bearer ${this.deepseekApiKey}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      const text =
        response.data?.choices?.[0]?.message?.content ||
        response.data?.choices?.[0]?.text;

      if (!text) {
        throw new Error('Empty response from DeepSeek API');
      }

      return {
        success: true,
        text,
        provider: 'deepseek',
      };
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError' || error.code === 'ECONNABORTED') {
        throw new Error(`DeepSeek API timeout after ${timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * Try DeepSeek API with true SSE streaming
   * Yields tokens as they arrive from the API
   */
  private async *tryDeepseekStream(
    request: LLMRequest,
    timeout: number
  ): AsyncGenerator<string> {
    if (!this.deepseekApiKey) {
      throw new Error('DEEPSEEK_API_KEY not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const model = request.model || this.deepseekModel;
      const response = await axios.post(
        `${this.deepseekBaseUrl}/chat/completions`,
        {
          model,
          messages: [
            ...(request.systemPrompt
              ? [{ role: 'system', content: request.systemPrompt }]
              : []),
            { role: 'user', content: request.prompt },
          ],
          temperature: request.temperature || 0.7,
          top_p: request.topP || 0.9,
          max_tokens: request.maxTokens || 512,
          stream: true,
        },
        {
          headers: {
            Authorization: `Bearer ${this.deepseekApiKey}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
          responseType: 'stream',
        }
      );

      let buffer = '';
      const stream: NodeJS.ReadableStream = response.data;

      for await (const rawChunk of stream) {
        buffer += rawChunk.toString();
        const lines = buffer.split('\n');
        // Keep the last potentially incomplete line in the buffer
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
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              yield delta;
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }

      clearTimeout(timeoutId);
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError' || error.code === 'ECONNABORTED' || error.code === 'ERR_CANCELED') {
        throw new Error(`DeepSeek stream timeout after ${timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * Get a local LLM stream generator (helper for generateStream and race mode)
   */
  private async *getLocalStream(request: LLMRequest): AsyncGenerator<string> {
    if (!this.localCppConfig) this.localCppConfig = this.buildLocalCppConfig();
    if (!this.localCppService) this.localCppService = getLocalLLMService(this.localCppConfig);

    const systemPrompt = request.systemPrompt?.trim();
    const userPrompt = (request.prompt || '').trim();
    const prompt = systemPrompt
      ? `System:\n${systemPrompt}\n\n${userPrompt}`
      : userPrompt;

    const merged = {
      temperature: request.temperature,
      topP: request.topP,
      maxTokens: Math.min(request.maxTokens || 128, 96)
    };

    const stream = this.localCppService.generateStream(prompt, merged);
    for await (const chunk of stream) {
      if (chunk) yield chunk;
    }
  }

  private isCppLocalLLM(): boolean {
    return ['cpp', 'llama-cpp', 'llamacpp'].includes(this.localLLMEngine);
  }

  private resolveLocalCppModelPath(): string | null {
    const rawPath = (process.env.LOCAL_LLM_MODEL_PATH || process.env.LOCAL_LLM_MODEL_NAME || '').trim();
    const fallbackCandidates = [
      path.resolve(process.cwd(), '..', 'models', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'),
      path.resolve(process.cwd(), '..', 'models', 'qwen3-4b', 'Qwen3-4B-Q4_K_M.gguf'),
      path.resolve(process.cwd(), '..', 'models', 'qwen3-4b', 'Qwen3-4B-Q5_K_M.gguf'),
    ];

    const resolved = rawPath
      ? (path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath))
      : (fallbackCandidates.find((candidate) => fs.existsSync(candidate)) || null);

    if (!resolved || !fs.existsSync(resolved)) {
      return null;
    }

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return resolved;
      }
      const ggufs = fs
        .readdirSync(resolved)
        .filter((name) => name.toLowerCase().endsWith('.gguf'))
        .sort();
      if (ggufs.length === 0) {
        return null;
      }
      return path.join(resolved, ggufs[0]);
    } catch {
      return null;
    }
  }

  private buildLocalCppConfig(): LLMConfig {
    const modelPath = this.resolveLocalCppModelPath();
    if (!modelPath) {
      throw new Error('LOCAL_LLM_MODEL_PATH not configured');
    }

    const contextSize = parseInt(process.env.LOCAL_LLM_CONTEXT_SIZE || '', 10);
    const temperature = parseFloat(process.env.LOCAL_LLM_TEMPERATURE || '');
    const topP = parseFloat(process.env.LOCAL_LLM_TOP_P || '');
    const maxTokens = parseInt(process.env.LOCAL_LLM_MAX_TOKENS || '', 10);
    const gpuLayersRaw = (process.env.LOCAL_LLM_GPU_LAYERS || '').trim().toLowerCase();

    let gpuLayers: LLMConfig['gpuLayers'];
    if (gpuLayersRaw === 'auto' || gpuLayersRaw === 'max') {
      gpuLayers = gpuLayersRaw;
    } else if (gpuLayersRaw) {
      const parsed = parseInt(gpuLayersRaw, 10);
      gpuLayers = Number.isNaN(parsed) ? 0 : parsed;
    }

    return {
      modelPath,
      contextSize: Number.isNaN(contextSize) ? undefined : contextSize,
      gpuLayers,
      temperature: Number.isNaN(temperature) ? undefined : temperature,
      topP: Number.isNaN(topP) ? undefined : topP,
      maxTokens: Number.isNaN(maxTokens) ? undefined : maxTokens,
    };
  }

  private isWithinWarmupWindow(): boolean {
    if (this.llmWarmupDone) {
      return false;
    }
    return Date.now() - this.llmWarmupStart < this.llmWarmupWindowMs;
  }

  private isWarmupError(error: Error): boolean {
    const message = (error?.message || '').toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('loading') ||
      message.includes('initializ') ||
      message.includes('not ready')
    );
  }

  private logWarmupOnce(): void {
    if (this.llmWarmupLogged) return;
    this.llmWarmupLogged = true;
    console.log('[LLM] Local cpp warming up. Requests will be buffered.');
  }

  private executeWithTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      operation(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Operation timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  private normalizeLocalText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    try {
      return String(value).trim();
    } catch {
      return '';
    }
  }

  /**
   * Try Local LLM
   */
  private async tryLocalLLM(
    request: LLMRequest,
    timeout: number
  ): Promise<LLMResult> {
    if (this.isCppLocalLLM()) {
      return this.tryLocalCppLLM(request, timeout);
    }
    throw new Error('LOCAL_LLM_ENGINE must be cpp');
  }

  private async tryLocalCppLLM(
    request: LLMRequest,
    timeout: number
  ): Promise<LLMResult> {
    const runGeneration = async (): Promise<LLMResult> => {
      if (!this.localCppConfig) {
        this.localCppConfig = this.buildLocalCppConfig();
      }

      if (!this.localCppService) {
        this.localCppService = getLocalLLMService(this.localCppConfig);
      }

      const merged: Partial<LLMConfig> = {};
      if (request.temperature !== undefined) {
        merged.temperature = request.temperature;
      }
      if (request.topP !== undefined) {
        merged.topP = request.topP;
      }
      if (request.maxTokens !== undefined) {
        merged.maxTokens = request.maxTokens;
      }

      const systemPrompt = request.systemPrompt?.trim();
      const userPrompt = (request.prompt || '').trim();
      const prompt = systemPrompt
        ? `System:\n${systemPrompt}\n\n${userPrompt}`
        : userPrompt;

      const response = await this.localCppService.generate(prompt, merged);
      const normalizedText = this.normalizeLocalText((response as any)?.text);

      return {
        success: true,
        text: normalizedText,
        provider: 'local',
      };
    };

    if (this.isWithinWarmupWindow()) {
      try {
        const result = await this.executeWithTimeout(runGeneration, timeout);
        if (result.success) {
          this.llmWarmupDone = true;
        }
        return result;
      } catch (error) {
        const err = error as Error;
        if (this.isWarmupError(err)) {
          this.logWarmupOnce();
          return { success: false, error: 'LLM_WARMUP', provider: 'local' };
        }
        throw err;
      }
    }

    const result = await this.fallbackManager.executeWithFallback<LLMResult>(
      'LLM_LOCAL_CPP',
      runGeneration,
      { success: false, error: 'Local LLM timeout', provider: 'local' } as LLMResult,
      timeout
    );

    if (result.success) {
      this.llmWarmupDone = true;
    }

    return result;
  }

  /**
   * Get fallback response
   */
  private getFallbackResponse(
    reason: string,
    error?: Error
  ): FallbackResponse {
    return createFallbackResponse(reason, error);
  }

  /**
   * Check if LLM is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      if (this.useLocalLLM) {
        const modelPath = this.resolveLocalCppModelPath();
        return !!(modelPath && fs.existsSync(modelPath));
      } else {
        // For DeepSeek, we can't really check availability without making a request
        // So we just check if API key is configured
        return !!this.deepseekApiKey;
      }
    } catch {
      return false;
    }
  }
}

// Global instance
let globalHandler: LLMFallbackHandler | null = null;

/**
 * Get or create global LLM fallback handler
 */
export function getGlobalLLMFallbackHandler(): LLMFallbackHandler {
  if (!globalHandler) {
    globalHandler = new LLMFallbackHandler();
  }
  return globalHandler;
}

/**
 * Reset global handler (for testing)
 */
export function resetGlobalLLMFallbackHandler(): void {
  globalHandler = null;
}
