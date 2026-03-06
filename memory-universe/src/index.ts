import dotenv from 'dotenv';
import path from 'path';
// 使用相对路径加载 .env
const envPath = path.resolve(__dirname, '../../.env');
console.log(`[Init] Loading .env from: ${envPath}`);
const result = dotenv.config({ path: envPath, override: true });
if (result.error) {
    console.error('[Init] Failed to load .env:', result.error);
} else {
    console.log('[Init] .env loaded successfully. USE_LLM_API=' + process.env.USE_LLM_API);
}

// 配置提示与降级说明
(() => {
    const useLocalLLM = process.env.USE_LOCAL_LLM === 'true';
    const useLLMApiDisabled = process.env.USE_LLM_API === 'false';
    const hasDeepseekKey = !!(process.env.DEEPSEEK_API_KEY || '').trim();

    if (!useLLMApiDisabled && !useLocalLLM && !hasDeepseekKey) {
        console.warn('[Config] Missing DEEPSEEK_API_KEY and local LLM is disabled; cloud LLM is unavailable.');
    }


})();

import { BrainSignal, RawStreamInput, SoulState } from './types/brain';
import { SignalProcessor } from './io/SignalProcessor';
import { SoulOrchestrator } from './core/SoulOrchestrator';
import {
    resolveChatContext,
    buildChatInput,
    normalizeChatBody,
    isRequestVerifiedCreator,
    resolveCreatorIdentity,
    shouldForceSlowRoute,
    extractRequestId,
    handleChatError
} from './middleware/chatMiddleware';
import { getControlManager, ControlCommand } from './core/ControlManager';
import express from 'express';
import axios from 'axios';
import { embeddingService } from './memory';
import { getLocalLLMService, LLMConfig } from './llm/LocalLLMService';
import fs from 'fs';
import crypto from 'crypto';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();

// 仅对 application/json 的 POST 等带 body 的请求做原始 body 缓存，便于容错与报错预览
app.use(express.raw({ type: 'application/json', limit: '1mb' }));
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json') || !Buffer.isBuffer(req.body)) {
        return next();
    }
    const raw = req.body.toString('utf8');
    (req as express.Request & { _rawBodyPreview?: string })._rawBodyPreview = raw.slice(0, 300);
    // 容错：去掉尾逗号（如 "source": "danmaku", }）后再解析
    const fixed = raw.replace(/,(\s*[}\]])/g, '$1');
    try {
        const bodyStr = fixed || '{}';
        (req as express.Request & { body: any }).body = JSON.parse(bodyStr);
    } catch (e: any) {
        const trimmedRaw = raw.trim();
        // 记录原始损坏报文
        console.error(`[BodyParser] CRITICAL: JSON Parse failed. Length: ${raw.length}. Last 50 chars: "${raw.slice(-50)}"`);

        if (e instanceof SyntaxError) {
            try {
                let patched = trimmedRaw;
                if (patched.endsWith(',')) patched = patched.slice(0, -1);

                const quoteCount = (patched.match(/"/g) || []).length;
                if (quoteCount % 2 !== 0) patched += '"';

                const openBraceCount = (patched.match(/{/g) || []).length;
                const closeBraceCount = (patched.match(/}/g) || []).length;
                if (openBraceCount > closeBraceCount) {
                    patched += '}'.repeat(openBraceCount - closeBraceCount);
                }

                const parsed = JSON.parse(patched);

                // 深度恢复：如果缺失 text 字段，尝试从截断的末尾提取
                if (!parsed.text || parsed.text === "undefined") {
                    const textMatch = raw.match(/"(?:text|message|content)"\s*:\s*"([^"]*)$/);
                    if (textMatch) {
                        parsed.text = textMatch[1];
                        console.warn(`[BodyParser] Recovered text field from truncation: "${parsed.text}"`);
                    }
                }

                (req as express.Request & { body: any }).body = parsed;
                console.warn(`[BodyParser] FIXED: JSON recovered. Patched body preview: ${JSON.stringify(parsed).slice(0, 100)}`);
                return next();
            } catch (innerError: any) {
                console.error(`[BodyParser] FATAL: Patch failed: ${innerError.message}`);
            }
        }

        const err = e instanceof SyntaxError ? e : new SyntaxError(e?.message);
        (err as SyntaxError & { status?: number }).status = 400;
        const posMatch = e?.message?.match(/position (\d+)/);
        if (posMatch) (err as SyntaxError & { position?: number }).position = parseInt(posMatch[1], 10);
        return next(err);
    }
    next();
});
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const isJsonParseError = err.status === 400 || err instanceof SyntaxError;
    if (isJsonParseError && typeof next === 'function') {
        const message = err.message || 'Invalid JSON';
        const pos = (err as SyntaxError & { position?: number }).position;
        const preview = (req as express.Request & { _rawBodyPreview?: string })._rawBodyPreview;
        console.warn('[BodyParser] Invalid JSON body:', message, pos != null ? `(position ${pos})` : '');
        if (preview) console.warn('[BodyParser] Body preview:', preview.replace(/\n/g, ' '));
        res.status(400).json({ success: false, error: 'Invalid JSON body', detail: message });
        return;
    }
    next(err);
});

const orchestrator = new SoulOrchestrator();
const processor = new SignalProcessor();

type ChatJobStatus = 'pending' | 'done' | 'error';

type ChatJob = {
    id: string;
    status: ChatJobStatus;
    createdAt: number;
    updatedAt: number;
    request: {
        text: string;
        userId?: string;
        userName?: string;
        source: 'danmaku' | 'gift' | 'creator';
        verifiedCreator?: boolean;
    };
    foregroundResult?: any;
    result?: any;
    error?: string;
};

const CHAT_JOBS = new Map<string, ChatJob>();
const DUAL_CHAT_BACKGROUND_ENABLED = process.env.DUAL_CHAT_BACKGROUND_ENABLED !== 'false';
const DUAL_CHAT_COMPLEXITY_THRESHOLD = Math.max(
    0,
    Math.min(1, Number.parseFloat(process.env.DUAL_CHAT_COMPLEXITY_THRESHOLD || '0.48') || 0.48)
);
const DUAL_CHAT_BACKGROUND_MIN_LENGTH = Math.max(
    4,
    Number.parseInt(process.env.DUAL_CHAT_BACKGROUND_MIN_LENGTH || '14', 10) || 14
);
const DUAL_CHAT_COMPLEX_KEYWORDS = [
    '为什么', '怎么', '如何', '原理', '步骤', '对比', '区别', '分析', '总结', '优化', '策略',
    'why', 'how', 'compare', 'difference', 'analysis', 'explain', 'optimize', 'strategy'
];
const ONLINE_DPO_ENABLED = process.env.ONLINE_DPO_ENABLED === 'true';
const ONLINE_DPO_ONLY_CREATOR = process.env.ONLINE_DPO_ONLY_CREATOR !== 'false';
const ONLINE_DPO_MIN_SCORE_GAP = Math.max(
    0,
    Math.min(1, Number.parseFloat(process.env.ONLINE_DPO_MIN_SCORE_GAP || '0.08') || 0.08)
);
const ONLINE_DPO_MAX_REPLY_CHARS = Math.max(
    24,
    Number.parseInt(process.env.ONLINE_DPO_MAX_REPLY_CHARS || '220', 10) || 220
);
const ONLINE_DPO_PATH = path.resolve(
    process.cwd(),
    process.env.ONLINE_DPO_PATH || '../data/dpo/online_pairs.jsonl'
);

type OnlineDpoStats = {
    enabled: boolean;
    onlyCreator: boolean;
    filePath: string;
    captured: number;
    skipped: number;
    lastCapturedAt: number | null;
    lastSkipReason: string;
    lastCaptureReason: string;
    minScoreGap: number;
};

const onlineDpoStats: OnlineDpoStats = {
    enabled: ONLINE_DPO_ENABLED,
    onlyCreator: ONLINE_DPO_ONLY_CREATOR,
    filePath: ONLINE_DPO_PATH,
    captured: 0,
    skipped: 0,
    lastCapturedAt: null,
    lastSkipReason: 'none',
    lastCaptureReason: 'none',
    minScoreGap: ONLINE_DPO_MIN_SCORE_GAP
};

function markOnlineDpoSkip(reason: string): void {
    onlineDpoStats.skipped += 1;
    onlineDpoStats.lastSkipReason = reason;
}

function markOnlineDpoCapture(reason: string): void {
    onlineDpoStats.captured += 1;
    onlineDpoStats.lastCapturedAt = Date.now();
    onlineDpoStats.lastCaptureReason = reason;
}

function getOnlineDpoStats(): OnlineDpoStats {
    return { ...onlineDpoStats };
}

function ensureOnlineDpoDir(): void {
    const dir = path.dirname(ONLINE_DPO_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function normalizeReplyText(value: any): string {
    return String(value ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasFallbackLikeReply(text: string): boolean {
    const source = normalizeReplyText(text).toLowerCase();
    if (!source) return true;
    return (
        source.includes('ai service temporarily unavailable') ||
        source.includes('请告诉创造者') ||
        source.includes('抱歉，我刚刚掉线了') ||
        source.includes('<think>')
    );
}

function scoreReplyQuality(reply: any): number {
    const text = normalizeReplyText(reply?.text || reply?.response || '');
    if (!text) return 0;

    let score = 0.2;
    const zhChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const latinChars = (text.match(/[A-Za-z]/g) || []).length;
    const len = text.length;

    if (len >= 8 && len <= ONLINE_DPO_MAX_REPLY_CHARS) score += 0.25;
    else if (len <= ONLINE_DPO_MAX_REPLY_CHARS + 120) score += 0.12;

    if (zhChars > 0) score += 0.2;
    if (latinChars > zhChars * 2 && zhChars < 8) score -= 0.08;
    if (!hasFallbackLikeReply(text)) score += 0.25;
    if (reply?.metadata?.route === 'slow') score += 0.08;
    if (reply?.metadata?.fallbackUsed === false) score += 0.05;

    return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

function tryCaptureOnlineDpoPair(job: ChatJob, foregroundResult: any, backgroundResult: any): void {
    if (!ONLINE_DPO_ENABLED) return;
    if (ONLINE_DPO_ONLY_CREATOR && job.request.source !== 'creator') {
        markOnlineDpoSkip('not_creator');
        return;
    }

    const prompt = normalizeReplyText(job.request.text);
    const fgText = normalizeReplyText(foregroundResult?.text || foregroundResult?.response || '');
    const bgText = normalizeReplyText(backgroundResult?.text || backgroundResult?.response || '');
    if (!prompt || !fgText || !bgText) {
        markOnlineDpoSkip('missing_text');
        return;
    }
    if (fgText === bgText) {
        markOnlineDpoSkip('same_reply');
        return;
    }
    if (fgText.length > ONLINE_DPO_MAX_REPLY_CHARS + 200 || bgText.length > ONLINE_DPO_MAX_REPLY_CHARS + 200) {
        markOnlineDpoSkip('reply_too_long');
        return;
    }

    const fgScore = scoreReplyQuality(foregroundResult);
    const bgScore = scoreReplyQuality(backgroundResult);
    const gap = Number(Math.abs(bgScore - fgScore).toFixed(3));
    let chosenFrom: 'foreground' | 'background' = bgScore >= fgScore ? 'background' : 'foreground';
    let captureReason = 'dual_quality_gap';
    if (gap < ONLINE_DPO_MIN_SCORE_GAP) {
        chosenFrom = bgText.length >= fgText.length ? 'background' : 'foreground';
        captureReason = 'tie_break_length';
    }
    const chosenText = chosenFrom === 'background' ? bgText : fgText;
    const rejectedText = chosenFrom === 'background' ? fgText : bgText;
    if (hasFallbackLikeReply(chosenText)) {
        markOnlineDpoSkip('chosen_fallback');
        return;
    }
    if (chosenText === rejectedText) {
        markOnlineDpoSkip('pair_duplicate');
        return;
    }

    const payload = {
        prompt,
        chosen: chosenText.slice(0, ONLINE_DPO_MAX_REPLY_CHARS),
        rejected: rejectedText.slice(0, ONLINE_DPO_MAX_REPLY_CHARS),
        metadata: {
            source: job.request.source,
            userId: job.request.userId || null,
            userName: job.request.userName || null,
            jobId: job.id,
            chosenFrom,
            captureReason,
            fgScore,
            bgScore,
            scoreGap: gap,
            fgProvider: foregroundResult?.llmProvider || foregroundResult?.metadata?.llmProvider || null,
            bgProvider: backgroundResult?.llmProvider || backgroundResult?.metadata?.llmProvider || null,
            fgRoute: foregroundResult?.metadata?.route || null,
            bgRoute: backgroundResult?.metadata?.route || null,
            createdAt: new Date().toISOString()
        }
    };

    try {
        ensureOnlineDpoDir();
        fs.appendFileSync(ONLINE_DPO_PATH, `${JSON.stringify(payload)}\n`, 'utf-8');
        markOnlineDpoCapture(captureReason);
    } catch (error: any) {
        markOnlineDpoSkip('write_failed');
        console.warn(`[OnlineDPO] Failed to write pair: ${error?.message || error}`);
    }
}


function createJobId(): string {
    return crypto.randomUUID ? crypto.randomUUID() : `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function pruneJobs(): void {
    const ttlMs = Number.parseInt(process.env.CHAT_JOB_TTL_MS || '600000', 10) || 600000;
    const maxJobs = Number.parseInt(process.env.CHAT_JOB_MAX || '200', 10) || 200;
    const now = Date.now();
    for (const [id, job] of CHAT_JOBS) {
        if (now - job.updatedAt > ttlMs) {
            CHAT_JOBS.delete(id);
        }
    }
    if (CHAT_JOBS.size > maxJobs) {
        const sorted = Array.from(CHAT_JOBS.values()).sort((a, b) => a.updatedAt - b.updatedAt);
        const excess = CHAT_JOBS.size - maxJobs;
        for (let i = 0; i < excess; i += 1) {
            CHAT_JOBS.delete(sorted[i].id);
        }
    }
}


function estimateMessageComplexity(text: string): { score: number; signals: string[] } {
    const t = String(text || '').trim();
    if (!t) return { score: 0, signals: ['empty'] };

    const signals: string[] = [];
    const lower = t.toLowerCase();
    let score = 0;

    if (t.length >= DUAL_CHAT_BACKGROUND_MIN_LENGTH) {
        score += 0.2;
        signals.push('length');
    }
    if (/[?？]/.test(t)) {
        score += 0.18;
        signals.push('question');
    }
    if (/[,，;；:：]/.test(t) || /(?:\n|。|！|!)/.test(t)) {
        score += 0.1;
        signals.push('multi_clause');
    }
    const keywordHits = DUAL_CHAT_COMPLEX_KEYWORDS.reduce((acc, keyword) => {
        return acc + (lower.includes(keyword) ? 1 : 0);
    }, 0);
    if (keywordHits > 0) {
        score += Math.min(0.36, keywordHits * 0.18);
        signals.push('complex_keyword');
    }

    return { score: Math.max(0, Math.min(1, score)), signals };
}


function shouldRunBackground(text: string, source?: string): { run: boolean; reason: string; score: number; signals: string[] } {
    const trimmed = String(text || '').trim();
    if (trimmed.startsWith('/')) {
        return { run: false, reason: 'command_message', score: 0, signals: ['command'] };
    }
    if (!DUAL_CHAT_BACKGROUND_ENABLED) {
        return { run: false, reason: 'disabled', score: 0, signals: ['disabled'] };
    }
    if (source === 'creator') {
        return { run: true, reason: 'creator_priority', score: 1, signals: ['creator'] };
    }
    const complexity = estimateMessageComplexity(text);
    if (complexity.score >= DUAL_CHAT_COMPLEXITY_THRESHOLD) {
        return { run: true, reason: 'complexity', score: complexity.score, signals: complexity.signals };
    }
    return { run: false, reason: 'simple_message', score: complexity.score, signals: complexity.signals };
}

function resolveLocalCppModelPath(): string | null {
    const rawPath = (process.env.LOCAL_LLM_MODEL_PATH || process.env.LOCAL_LLM_MODEL_NAME || '').trim();
    const fallbackCandidates = [
        path.resolve(process.cwd(), '..', 'models', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'),
        path.resolve(process.cwd(), '..', 'models', 'qwen3-4b', 'Qwen3-4B-Q4_K_M.gguf'),
        path.resolve(process.cwd(), '..', 'models', 'qwen3-4b', 'Qwen3-4B-Q5_K_M.gguf')
    ];

    const resolved = rawPath
        ? (path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath))
        : (fallbackCandidates.find((candidate) => fs.existsSync(candidate)) || null);

    if (!resolved || !fs.existsSync(resolved)) return null;

    try {
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) return resolved;
        const ggufs = fs
            .readdirSync(resolved)
            .filter((name) => name.toLowerCase().endsWith('.gguf'))
            .sort();
        if (ggufs.length === 0) return null;
        return path.join(resolved, ggufs[0]);
    } catch {
        return null;
    }
}

function buildLocalCppConfig(): LLMConfig | null {
    const modelPath = resolveLocalCppModelPath();
    if (!modelPath || !fs.existsSync(modelPath)) return null;

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
        maxTokens: Number.isNaN(maxTokens) ? undefined : maxTokens
    };
}

async function warmupLocalCppIfEnabled(): Promise<void> {
    const useLocalLLM = process.env.USE_LOCAL_LLM === 'true';
    const engine = (process.env.LOCAL_LLM_ENGINE || '').toLowerCase();
    const isCpp = ['cpp', 'llama-cpp', 'llamacpp'].includes(engine);
    if (!useLocalLLM || !isCpp) return;

    const config = buildLocalCppConfig();
    if (!config) {
        console.warn('[LocalLLM] Skipping cpp warmup: model path not found.');
        return;
    }

    try {
        console.log('[LocalLLM] Warming up cpp model in background...');
        await getLocalLLMService(config).initialize();
        console.log('[LocalLLM] cpp model ready.');
    } catch (error: any) {
        console.warn('[LocalLLM] cpp warmup failed:', error?.message || error);
    }
}

// 1. 核心聊天接口 (Proxy for Manager)
app.post('/api/chat', async (req, res) => {
    try {
        const ctx = resolveChatContext(req);
        if (!ctx) {
            return res.status(400).json({ success: false, error: 'message/text/content is required' });
        }
        const input = buildChatInput(ctx, processor, req);
        if (ctx.forceSlowRoute) {
            console.log(`[Chat/RouteHint] force slow for text="${ctx.text.slice(0, 40)}"`);
        }
        const result = await orchestrator.chat(input);
        console.log(`[Chat] rid=${input.requestId || 'na'} reply ok: ${result?.text?.slice(0, 50) || '...'}`);
        res.json(result);
    } catch (error: any) {
        handleChatError(res, error, 'Chat', extractRequestId(req));
    }
});

app.post('/api/chat/stream', async (req, res) => {
    try {
        const ctx = resolveChatContext(req);
        if (!ctx) {
            return res.status(400).json({ success: false, error: 'message/text/content is required' });
        }

        console.log(`[SSE] Init stream: ${ctx.text.slice(0, 20)}... from ${ctx.userId || 'viewer'}`);

        const input = buildChatInput(ctx, processor, req);
        if (ctx.forceSlowRoute) {
            console.log(`[SSE/RouteHint] force slow for text="${ctx.text.slice(0, 40)}"`);
        }

        // Headers for SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        // Send a comment chunk to clear any proxy buffers
        res.write(': sse-keep-alive\n\n');
        console.log(`[SSE] Headers flushed and keep-alive sent for ${input.userId} (rid=${input.requestId})`);

        const stream = orchestrator.chatStream(input);
        let chunkCount = 0;

        for await (const chunk of stream) {
            chunkCount++;
            res.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
            if ((res as any).flush) (res as any).flush();
        }

        console.log(`[SSE] Stream done. Total chunks: ${chunkCount}`);
        res.write('data: [DONE]\n\n');
        res.end();

    } catch (error: any) {
        const rid = extractRequestId(req);
        console.error(`[SSE] rid=${rid} failed:`, error.message);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: error.message });
        } else {
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        }
    }
});

app.post('/api/chat/dual', async (req, res) => {
    try {
        const ctx = resolveChatContext(req);
        if (!ctx) {
            return res.status(400).json({ success: false, error: 'message/text/content is required' });
        }
        const { text, userId, userName, source, creatorSession, creatorIdentity } = ctx;
        const normalizedSource: 'danmaku' | 'gift' | 'creator' =
            source === 'gift' ? 'gift' : (creatorSession ? 'creator' : 'danmaku');

        pruneJobs();
        const jobId = createJobId();
        const createdAt = Date.now();

        const job: ChatJob = {
            id: jobId,
            status: 'pending',
            createdAt,
            updatedAt: createdAt,
            request: {
                text,
                userId: creatorIdentity?.userId || userId,
                userName: creatorIdentity?.userName || userName,
                source: normalizedSource,
                verifiedCreator: creatorSession
            }
        };
        CHAT_JOBS.set(jobId, job);

        const foregroundInput = processor.processDanmaku(creatorIdentity?.userId || userId || 'viewer', text);
        foregroundInput.userName = creatorIdentity?.userName || userName;
        foregroundInput.source = job.request.source;
        foregroundInput.requestId = jobId;
        foregroundInput.processingMode = 'foreground';
        foregroundInput.routeHint = job.request.source === 'creator' || shouldForceSlowRoute(text) ? 'slow' : 'fast';
        if (creatorSession) {
            foregroundInput.verifiedCreator = true;
        }

        const foregroundResult = await orchestrator.chat(foregroundInput);
        job.foregroundResult = foregroundResult;
        job.updatedAt = Date.now();

        const backgroundDecision = shouldRunBackground(text, job.request.source);
        console.log(
            `[DualChat] job=${jobId} background=${backgroundDecision.run} reason=${backgroundDecision.reason} score=${backgroundDecision.score.toFixed(3)} signals=${backgroundDecision.signals.join('|')}`
        );
        if (backgroundDecision.run) {
            const backgroundInput: RawStreamInput = {
                content: text,
                source: job.request.source,
                userId: creatorIdentity?.userId || userId,
                userName: creatorIdentity?.userName || userName,
                requestId: jobId,
                processingMode: 'background',
                routeHint: 'slow',
                features: {
                    intensity: foregroundInput.features.intensity,
                    sentiment_hint: foregroundInput.features.sentiment_hint,
                    timestamp: foregroundInput.features.timestamp
                }
            };
            if (creatorSession) {
                backgroundInput.verifiedCreator = true;
            }
            setTimeout(async () => {
                const current = CHAT_JOBS.get(jobId);
                if (!current || current.status !== 'pending') return;
                try {
                    const result = await orchestrator.chat(backgroundInput);
                    tryCaptureOnlineDpoPair(current, current.foregroundResult || foregroundResult, result);
                    current.status = 'done';
                    current.updatedAt = Date.now();
                    current.result = result;
                } catch (err: any) {
                    current.status = 'error';
                    current.updatedAt = Date.now();
                    current.error = err?.message || String(err);
                }
            }, 0);
        } else {
            const current = CHAT_JOBS.get(jobId);
            if (current) {
                current.status = 'done';
                current.updatedAt = Date.now();
                current.result = {
                    ...(foregroundResult || {}),
                    metadata: {
                        ...(foregroundResult?.metadata || {}),
                        backgroundSkipped: true,
                        backgroundSkipReason: backgroundDecision.reason,
                        backgroundComplexity: Number(backgroundDecision.score.toFixed(3)),
                        backgroundSignals: backgroundDecision.signals
                    }
                };
            }
        }

        res.json({
            success: true,
            jobId,
            foreground: foregroundResult
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || 'Dual chat failed' });
    }
});

app.get('/api/chat/result', async (req, res) => {
    const jobId = String(req.query.jobId || '').trim();
    if (!jobId) {
        return res.status(400).json({ success: false, error: 'jobId is required' });
    }
    const job = CHAT_JOBS.get(jobId);
    if (!job) {
        return res.status(404).json({ success: false, error: 'job not found' });
    }
    res.json({
        success: true,
        jobId: job.id,
        status: job.status,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt
    });
});

// 2. 主播专用聊天接口
app.post('/api/chat/creator', async (req, res) => {
    try {
        const { text, userId, userName } = normalizeChatBody(req.body);
        if (!text) {
            return res.status(400).json({ success: false, error: 'message/text/content is required' });
        }
        const isVerified = isRequestVerifiedCreator(req);
        const creatorIdentity = resolveCreatorIdentity(userId, userName);
        const input: RawStreamInput = {
            content: text,
            source: 'creator' as const,
            userId: creatorIdentity.userId,
            userName: creatorIdentity.userName,
            features: { intensity: 0.8, sentiment_hint: 0, timestamp: Date.now() },
            verifiedCreator: isVerified
        };
        const result = await orchestrator.chat(input);
        res.json(result);
    } catch (error: any) {
        handleChatError(res, error, 'Chat/Creator', extractRequestId(req));
    }
});

// 3. 事件驱动接口 (来自 Danmaku Service)
app.post('/event', async (req, res) => {
    try {
        const { type, content, metadata } = req.body;
        let input: RawStreamInput;

        if (type === 'danmaku') {
            input = processor.processDanmaku(metadata?.user || 'unknown', content);
        } else if (type === 'gift') {
            input = processor.processGift(metadata?.user || 'unknown', metadata?.gift || '绀肩墿', metadata?.count || 1);
        } else {
            const isVerified = isRequestVerifiedCreator(req);
            const creatorIdentity = resolveCreatorIdentity(metadata?.userId || metadata?.uid || metadata?.user, metadata?.userName || metadata?.uname || metadata?.name);
            input = {
                content: String(content),
                source: 'creator',
                userId: creatorIdentity.userId,
                userName: creatorIdentity.userName,
                features: { intensity: 0.5, sentiment_hint: 0, timestamp: Date.now() },
                verifiedCreator: isVerified
            };
        }

        const result = await orchestrator.chat(input);
        res.json({ success: true, result });
    } catch (error: any) {
        console.error(`[Event] Handler failed:`, error.message);
        res.json({
            success: false,
            error: error.message || 'Unknown error',
            result: { text: '\u8bf7\u544a\u8bc9\u521b\u4f5c\u8005\uff1aAI\u6682\u65f6\u51fa\u73b0\u95ee\u9898\u3002' }
        });
    }
});

app.get('/api/persona/state', async (req, res) => {
    const state = await orchestrator.getLegacyState();
    res.json(state);
});

// 6. 学习反馈
app.post('/api/learning/feedback', async (req, res) => {
    const brainUrl = process.env.BRAINNN_URL || 'http://localhost:4007';
    const response = await axios.post(`${brainUrl}/feedback`, req.body);
    res.json(response.data);
});

// 7. 健康检查
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        version: '3.2.0-v7.2-phase2',
        arch: 'GlobalCognitiveWorkspace + HippocampusMemory'
    });
});

// ========== Phase 2: 记忆系统 API ==========

// 8. 记忆统计
app.get('/api/memory/stats', (req, res) => {
    const stats = orchestrator.getMemoryStats();
    res.json(stats);
});

app.get('/api/intelligence/stats', (req, res) => {
    const stats = orchestrator.getIntelligenceStats();
    res.json({
        success: true,
        data: {
            ...stats,
            onlineDpo: getOnlineDpoStats()
        }
    });
});

app.get('/api/online-dpo/stats', (req, res) => {
    res.json({ success: true, data: getOnlineDpoStats() });
});

// 9. 手动触发做梦/反思
app.post('/api/memory/dream', async (req, res) => {
    try {
        const result = await orchestrator.triggerDreaming();
        res.json({ success: true, result });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 10. 预热 Embedding 模型 (可选，启动时调用)
app.post('/api/memory/warmup', async (req, res) => {
    try {
        await embeddingService.initialize();
        res.json({ success: true, message: 'Embedding model warmed up' });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== Phase 3: 后台控制 API ==========

const controlManager = getControlManager();

// 11. 话题控制
app.post('/api/control/topic/start', async (req, res) => {
    try {
        const { topic, context, priority = 'normal' } = req.body;
        if (!topic) {
            return res.status(400).json({ success: false, error: 'topic is required' });
        }
        controlManager.startTopic(topic, context, priority);
        res.json({ success: true, message: `话题已启动: ${topic}` });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/control/topic/switch', async (req, res) => {
    try {
        const { fromTopic, toTopic, transition = 'smooth', context } = req.body;
        if (!toTopic) {
            return res.status(400).json({ success: false, error: 'toTopic is required' });
        }
        controlManager.switchTopic(fromTopic, toTopic, transition, context);
        res.json({ success: true, message: `话题已切换: ${fromTopic || '无'} → ${toTopic}` });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/control/topic/end', async (req, res) => {
    try {
        const { topic, reason } = req.body;
        if (!topic) {
            return res.status(400).json({ success: false, error: 'topic is required' });
        }
        controlManager.endTopic(topic, reason);
        res.json({ success: true, message: `话题已结束: ${topic}` });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 12. 行为控制
app.post('/api/control/behavior/set', async (req, res) => {
    try {
        const { behavior, duration, reason } = req.body;
        if (!behavior || !['proactive', 'reactive', 'silent'].includes(behavior)) {
            return res.status(400).json({ success: false, error: 'behavior must be proactive, reactive, or silent' });
        }
        controlManager.setBehavior(behavior, duration, reason);
        res.json({ success: true, message: `行为模式已设置: ${behavior}` });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 13. 情绪控制
app.post('/api/control/mood/set', async (req, res) => {
    try {
        const { mood, intensity = 0.7, duration } = req.body;
        if (!mood) {
            return res.status(400).json({ success: false, error: 'mood is required' });
        }
        controlManager.setMood(mood, intensity, duration);
        res.json({ success: true, message: `情绪已设置: ${mood} (强度: ${intensity})` });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 14. 实时指令
app.post('/api/control/command', async (req, res) => {
    try {
        const { command, params } = req.body;
        if (!command) {
            return res.status(400).json({ success: false, error: 'command is required' });
        }
        const result = await controlManager.executeCommand(command, params);
        res.json({ success: true, result, message: `指令已执行: ${command}` });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 15. 获取控制状态
app.get('/api/control/state', (req, res) => {
    try {
        const state = controlManager.getState();
        res.json({ success: true, data: state });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 16. Subtitle API for Live2D
let currentSubtitle = '';
let currentSubtitleDuration = 0;
let currentEmotion = '';
let currentAudio: any = null;

app.get('/api/subtitle', (req, res) => {
    res.json({ subtitle: currentSubtitle, emotion: currentEmotion });
});

app.post('/api/subtitle', (req, res) => {
    const { text, streaming, duration_ms } = req.body || {};
    if (text === undefined) {
        return res.status(400).json({ error: 'Text is required' });
    }
    currentSubtitle = String(text);
    currentSubtitleDuration = Number.isFinite(Number(duration_ms)) ? Math.max(0, Number(duration_ms)) : 0;
    console.log('[Subtitle] Updated:', currentSubtitle.slice(0, 60));
    res.json({ success: true, streaming: !!streaming, duration_ms: currentSubtitleDuration });
});

app.post('/api/subtitle/clear', (req, res) => {
    currentSubtitle = '';
    currentSubtitleDuration = 0;
    res.json({ success: true });
});

app.post('/api/emotion', (req, res) => {
    const { emotion } = req.body || {};
    if (!emotion) {
        return res.status(400).json({ error: 'Emotion is required' });
    }
    currentEmotion = String(emotion);
    console.log('[Emotion] Updated:', currentEmotion);
    res.json({ success: true });
});

app.get('/api/audio/current', (req, res) => {
    res.json({
        audio: currentAudio,
        subtitle: currentSubtitle,
        subtitleDuration: currentSubtitleDuration,
        emotion: currentEmotion
    });
});

let runtimeConfig: any = null;

app.get('/api/config', (req, res) => {
    res.json({
        model: runtimeConfig || {
            scale: parseFloat(process.env.LIVE2D_MODEL_SCALE || '0.25'),
            x: parseFloat(process.env.LIVE2D_MODEL_X || '0.3'),
            y: parseFloat(process.env.LIVE2D_MODEL_Y || '0.5')
        },
        mouthSpeed: 20,
        subtitle: {
            baseFontSize: 36,
            minFontSize: 30,
            fontScaleStep: 1.5
        }
    });
});

// Helper to update .env content
function upsertEnvValue(content: string, key: string, value: any): string {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escapedKey}=.*$`, 'm');
    const line = `${key}=${value}`;

    if (pattern.test(content)) {
        return content.replace(pattern, line);
    }
    const trimmed = content.trimEnd();
    return trimmed ? `${trimmed}\n${line}\n` : `${line}\n`;
}

app.post('/api/config/update', (req, res) => {
    const { scale, x, y } = req.body || {};

    // Validate inputs
    if (![scale, x, y].every(Number.isFinite)) {
        return res.status(400).json({ success: false, error: 'Invalid config: scale, x, y must be checked' });
    }

    const newScale = Number(scale);
    const newX = Number(x);
    const newY = Number(y);

    // Update runtime config (immediate effect)
    runtimeConfig = { scale: newScale, x: newX, y: newY };

    // Update process.env (persistence until restart)
    process.env.LIVE2D_MODEL_SCALE = String(newScale);
    process.env.LIVE2D_MODEL_X = String(newX);
    process.env.LIVE2D_MODEL_Y = String(newY);

    console.log('[Config] Runtime updated:', runtimeConfig);

    // Persist to .env file
    try {
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }

        envContent = upsertEnvValue(envContent, 'LIVE2D_MODEL_SCALE', newScale);
        envContent = upsertEnvValue(envContent, 'LIVE2D_MODEL_X', newX);
        envContent = upsertEnvValue(envContent, 'LIVE2D_MODEL_Y', newY);

        fs.writeFileSync(envPath, envContent, 'utf8');
        console.log('[Config] Persisted successfully to .env:', { scale: newScale, x: newX, y: newY });
        return res.json({ success: true, message: 'Config updated and persisted' });
    } catch (error: any) {
        console.error('[Config] Failed to persist .env:', error.message);
        // Still return success because runtime update worked
        return res.json({ success: true, message: 'Config updated (runtime only)', warning: 'Failed to persist to disk' });
    }
});

app.post('/api/audio/stop', (req, res) => {
    currentAudio = null;
    res.json({ success: true });
});

app.post('/audio/play', (req, res) => {
    const { audioPath, duration, mouthParams, msg_id, text, emotion, motion } = req.body || {};
    currentAudio = {
        audioPath,
        duration: Number.isFinite(Number(duration)) ? Number(duration) : 3,
        mouthParams: Array.isArray(mouthParams) ? mouthParams : [],
        msg_id: msg_id || '',
        text: text || '',
        emotion: emotion || '',
        motion: motion || '',
        timestamp: Date.now()
    };
    console.log('[Audio] Playing:', audioPath);
    res.json({ success: true });
});

const PORT = parseInt(process.env.MEMORY_UNIVERSE_PORT || '4005', 10);

// Static file serving for live2d and danmaku
const live2dDir = path.resolve(__dirname, '../../memory-live2d');
const danmakuDir = path.resolve(__dirname, '../../memory-danmaku');

if (fs.existsSync(live2dDir)) {
    app.use('/live2d', express.static(live2dDir));
    console.log(`[Static] Serving live2d at /live2d`);
}
if (fs.existsSync(danmakuDir)) {
    app.use('/danmaku', express.static(danmakuDir));
    console.log(`[Static] Serving danmaku at /danmaku`);
}

app.get('/', (req, res) => {
    res.redirect('/live2d/index.html');
});

// WebSocket server for AI status
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });
const wsClients = new Set<WebSocket>();

wss.on('connection', (ws: WebSocket) => {
    wsClients.add(ws);
    console.log(`[WS] Client connected, total: ${wsClients.size}`);
    ws.send(JSON.stringify({ type: 'status', status: 'idle' }));
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
});

httpServer.listen(PORT, async () => {
    console.log(`[Init] Memory Universe V3.2 listening on port ${PORT}`);
    console.log(`[WS] WebSocket server ready`);
    embeddingService.initialize().catch(() => { });
    warmupLocalCppIfEnabled().catch(() => { });
});
