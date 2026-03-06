import { pathToFileURL } from 'url';

export interface LLMConfig {
    modelPath: string;
    contextSize?: number;
    gpuLayers?: number | 'auto' | 'max';
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    statelessChat?: boolean;
}

export interface LLMResponse {
    text: string;
    tokens: number;
    elapsed: number;
}

export class LocalLLMService {
    private llama: any = null;
    private model: any = null;
    private session: any = null;
    private config: LLMConfig;
    private isInitializing: boolean = false;
    private initPromise: Promise<void> | null = null;

    private static llamaModule: null | {
        getLlama: typeof import('node-llama-cpp').getLlama;
        LlamaChatSession: typeof import('node-llama-cpp').LlamaChatSession;
    } = null;

    constructor(config: LLMConfig) {
        this.config = {
            contextSize: 2048,
            gpuLayers: 0,
            temperature: 0.7,
            topP: 0.9,
            maxTokens: 512,
            statelessChat: process.env.LOCAL_LLM_STATELESS !== 'false',
            ...config
        };
    }

    private isLikelyVramError(error: any): boolean {
        const message = String(error?.message || '').toLowerCase();
        return (
            message.includes('vram') ||
            message.includes('out of memory') ||
            message.includes('too large') ||
            message.includes('context size') ||
            message.includes('cuda')
        );
    }

    private isRecoverableInitError(error: any): boolean {
        const message = String(error?.message || '').toLowerCase();
        return (
            this.isLikelyVramError(error) ||
            message.includes('gpu') ||
            message.includes('context')
        );
    }

    private buildGpuCandidates(): Array<number | 'auto' | 'max'> {
        const configured = this.config.gpuLayers;

        if (configured === 'auto' || configured === 'max') {
            return ['auto', 24, 16, 12, 8, 4, 0];
        }

        if (typeof configured === 'number' && configured > 0) {
            return Array.from(
                new Set<number>([
                    configured,
                    Math.max(0, Math.floor(configured * 0.75)),
                    Math.max(0, Math.floor(configured * 0.5)),
                    12,
                    8,
                    4,
                    0
                ])
            );
        }

        return [0];
    }

    private buildContextCandidates(requestedContext: number): number[] {
        const preferred = [
            requestedContext,
            1536,
            1024,
            768,
            512,
            384,
            256
        ].filter((v) => v <= requestedContext);

        if (!preferred.includes(requestedContext)) {
            preferred.unshift(requestedContext);
        }

        return Array.from(new Set(preferred)).sort((a, b) => b - a);
    }

    private async cleanupPartialInit(): Promise<void> {
        try {
            if (this.session && typeof this.session.dispose === 'function') {
                await this.session.dispose();
            }
        } catch {
            // ignore
        }
        this.session = null;

        try {
            if (this.model && typeof this.model.dispose === 'function') {
                await this.model.dispose();
            }
        } catch {
            // ignore
        }
        this.model = null;
    }

    private resetSessionHistoryIfEnabled(): void {
        if (!this.session || this.config.statelessChat === false) {
            return;
        }

        try {
            if (typeof this.session.resetChatHistory === 'function') {
                this.session.resetChatHistory();
                return;
            }
            if (typeof this.session.setChatHistory === 'function') {
                this.session.setChatHistory([]);
            }
        } catch (error: any) {
            console.warn(`[LocalLLM] Failed to reset chat history: ${error?.message || error}`);
        }
    }

    private extractResponseText(rawResponse: any): string {
        if (rawResponse == null) return '';
        if (typeof rawResponse === 'string') return rawResponse;

        if (Array.isArray(rawResponse)) {
            return rawResponse
                .map((item) => {
                    if (typeof item === 'string') return item;
                    if (item && typeof item === 'object') {
                        return item.text ?? item.content ?? '';
                    }
                    return '';
                })
                .join('');
        }

        if (typeof rawResponse === 'object') {
            const direct =
                rawResponse.text ??
                rawResponse.response ??
                rawResponse.content ??
                rawResponse.message?.content ??
                rawResponse.answer;

            if (typeof direct === 'string') return direct;
            if (Array.isArray(direct)) {
                const joined = direct.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('');
                if (joined.trim()) return joined;
            }
        }

        try {
            return String(rawResponse);
        } catch {
            return '';
        }
    }

    async initialize(): Promise<void> {
        if (this.model && this.session) {
            return;
        }

        if (this.model && !this.session) {
            await this.cleanupPartialInit();
        }

        if (this.isInitializing && this.initPromise) {
            return this.initPromise;
        }

        this.isInitializing = true;
        this.initPromise = this.doInitialize();
        return this.initPromise;
    }

    private async doInitialize(): Promise<void> {
        try {
            console.log(`[LocalLLM] Loading model: ${this.config.modelPath}...`);
            const startTime = Date.now();

            if (!LocalLLMService.llamaModule) {
                const modulePath = require.resolve('node-llama-cpp');
                const moduleUrl = pathToFileURL(modulePath).href;
                LocalLLMService.llamaModule = await import(moduleUrl);
            }

            const { getLlama, LlamaChatSession } = LocalLLMService.llamaModule!;
            this.llama = await getLlama();

            const requestedContext = Math.max(256, this.config.contextSize || 2048);
            const contextCandidates = this.buildContextCandidates(requestedContext);
            const gpuCandidates = this.buildGpuCandidates();

            let context: any = null;
            let lastError: any = null;
            let selectedGpu: number | 'auto' | 'max' = this.config.gpuLayers ?? 0;

            for (const gpuLayers of gpuCandidates) {
                try {
                    this.model = await this.llama.loadModel({
                        modelPath: this.config.modelPath,
                        gpuLayers
                    });

                    for (const contextSize of contextCandidates) {
                        try {
                            context = await this.model.createContext({ contextSize });
                            selectedGpu = gpuLayers;
                            this.config.gpuLayers = gpuLayers;
                            this.config.contextSize = contextSize;
                            if (contextSize !== requestedContext) {
                                console.warn(`[LocalLLM] Context fallback: ${requestedContext} -> ${contextSize}`);
                            }
                            break;
                        } catch (error: any) {
                            lastError = error;
                            if (!this.isRecoverableInitError(error)) {
                                throw error;
                            }
                        }
                    }

                    if (context) {
                        break;
                    }

                    await this.cleanupPartialInit();
                    console.warn(`[LocalLLM] Retrying with lower GPU usage (gpuLayers=${gpuLayers}).`);
                } catch (error: any) {
                    lastError = error;
                    await this.cleanupPartialInit();
                    if (!this.isRecoverableInitError(error)) {
                        throw error;
                    }
                }
            }

            if (!context) {
                throw lastError || new Error('Failed to initialize local LLM context');
            }

            this.session = new LlamaChatSession({
                contextSequence: context.getSequence()
            });

            const elapsed = Date.now() - startTime;
            console.log(`[LocalLLM] Using gpuLayers=${selectedGpu}, context=${this.config.contextSize}`);
            console.log(`[LocalLLM] Model loaded in ${elapsed}ms`);
        } catch (error: any) {
            await this.cleanupPartialInit();
            console.error(`[LocalLLM] Failed to load model: ${error?.message || error}`);
            throw error;
        } finally {
            this.isInitializing = false;
            this.initPromise = null;
        }
    }

    async generate(prompt: string, options?: Partial<LLMConfig>): Promise<LLMResponse> {
        await this.initialize();
        if (!this.session) {
            throw new Error('Local LLM session is not initialized');
        }

        const startTime = Date.now();

        try {
            const mergedConfig = { ...this.config, ...options };
            this.resetSessionHistoryIfEnabled();

            const promptOptions = {
                temperature: mergedConfig.temperature,
                topP: mergedConfig.topP,
                maxTokens: mergedConfig.maxTokens
            };

            let rawResponse: any;
            if (typeof this.session.promptWithMeta === 'function') {
                const meta = await this.session.promptWithMeta(prompt, promptOptions);
                rawResponse = meta?.responseText;
                if (!this.extractResponseText(rawResponse).trim()) {
                    rawResponse = meta?.response;
                }
            } else {
                rawResponse = await this.session.prompt(prompt, promptOptions);
            }

            const responseText = this.extractResponseText(rawResponse);
            const elapsed = Date.now() - startTime;

            return {
                text: responseText,
                tokens: this.estimateTokens(responseText),
                elapsed
            };
        } catch (error: any) {
            console.error(`[LocalLLM] Generation error: ${error?.message || error}`);
            throw error;
        }
    }

    async *generateStream(prompt: string, options?: Partial<LLMConfig>): AsyncGenerator<string> {
        await this.initialize();
        if (!this.session) {
            throw new Error('Local LLM session is not initialized');
        }

        const mergedConfig = { ...this.config, ...options };
        this.resetSessionHistoryIfEnabled();

        const tokenQueue: string[] = [];
        let resolveToken: ((v?: any) => void) | null = null;
        let isDone = false;
        let error: any = null;

        console.log(`[LocalLLM] generateStream called. Prompt length: ${prompt.length}`);
        // Start generation in background
        const generationPromise = this.session.prompt(prompt, {
            temperature: mergedConfig.temperature,
            topP: mergedConfig.topP,
            maxTokens: mergedConfig.maxTokens,
            onTextChunk: (text: string) => {
                // console.log(`[LocalLLM] onTextChunk: "${text}"`); 
                tokenQueue.push(text);
                if (resolveToken) {
                    const r = resolveToken;
                    resolveToken = null;
                    r();
                }
            }
        }).then(() => {
            isDone = true;
            if (resolveToken) resolveToken();
        }).catch((err: any) => {
            error = err;
            isDone = true;
            if (resolveToken) resolveToken();
        });

        while (!isDone || tokenQueue.length > 0) {
            if (tokenQueue.length > 0) {
                yield tokenQueue.shift()!;
            } else if (error) {
                throw error;
            } else if (isDone) {
                break;
            } else {
                await new Promise((r) => { resolveToken = r; });
            }
        }

        await generationPromise;
    }

    async chat(message: string, systemPrompt?: string): Promise<string> {
        await this.initialize();

        const fullPrompt = systemPrompt
            ? `${systemPrompt}\n\nUser: ${message}\nAssistant: `
            : `User: ${message}\nAssistant: `;

        const response = await this.generate(fullPrompt);
        return response.text;
    }

    private estimateTokens(text: string): number {
        return Math.ceil((text || '').length / 4);
    }

    async dispose(): Promise<void> {
        await this.cleanupPartialInit();
        console.log('[LocalLLM] Resources disposed');
    }
}

let localLLMServiceInstance: LocalLLMService | null = null;

export function getLocalLLMService(config?: LLMConfig): LocalLLMService {
    if (!localLLMServiceInstance && config) {
        localLLMServiceInstance = new LocalLLMService(config);
    }
    return localLLMServiceInstance!;
}
