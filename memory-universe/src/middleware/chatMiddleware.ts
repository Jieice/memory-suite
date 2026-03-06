/**
 * Chat Middleware — shared logic for /api/chat, /api/chat/stream,
 * /api/chat/dual, /api/chat/creator endpoints.
 *
 * Deduplicates: body normalization, creator verification, identity
 * resolution, input building, route-hint, request-id, error response.
 */

import express from 'express';
import { RawStreamInput } from '../types/brain';
import { SignalProcessor } from '../io/SignalProcessor';

// ── Constants ──────────────────────────────────────────────────

const MU_CREATOR_TOKEN = (process.env.MU_CREATOR_TOKEN || '').trim();

const DEFAULT_CREATOR_USER_ID =
    (process.env.CREATOR_USER_ID || 'Jieice').trim() || 'Jieice';
const DEFAULT_CREATOR_USER_NAME =
    (process.env.CREATOR_DISPLAY_NAME || '宇杰').trim() || '宇杰';

const CHAT_ERROR_FALLBACK =
    '\u62b1\u6b49\uff0c\u6211\u521a\u521a\u6709\u70b9\u5361\u4f4f\u4e86\u3002\u4f60\u518d\u8bf4\u4e00\u904d\uff0c\u6211\u9a6c\u4e0a\u7ee7\u7eed\u3002';

const FORCE_SLOW_RE =
    /(你能做什么|不能做什么|能力|功能|状态|启动|运行|在线|离线|tts|sovits|gpt-sovits|live2d|brainnn|manager|readiness|health|status|如何|为什么|步骤|分析|对比|优化|报错|debug|what can you do|what are your capabilities|ready|running|how|why)/i;

// ── Types ──────────────────────────────────────────────────────

export interface NormalizedChatBody {
    text: string;
    userId?: string;
    userName?: string;
    source?: string;
}

export interface ChatContext {
    text: string;
    userId?: string;
    userName?: string;
    source?: string;
    isVerified: boolean;
    creatorSession: boolean;
    creatorIdentity: { userId: string; userName: string } | null;
    forceSlowRoute: boolean;
}

// ── Pure helpers (exported for reuse & testing) ────────────────

export function normalizeChatBody(body: any): NormalizedChatBody {
    const text = String(body?.message ?? body?.text ?? body?.content ?? '').trim();
    const userId = body?.userId ?? body?.uid ?? body?.user ?? undefined;
    const userName = body?.userName ?? body?.uname ?? body?.name ?? undefined;
    const source = body?.source;

    if (!text || !userId) {
        console.error(
            `[Chat/Normalize] Missing critical fields: text="${text}", userId="${userId}", source="${source}"`
        );
    } else {
        console.log(
            `[Chat/Normalize] Request normalized: userId="${userId}", textLength=${text.length}, source="${source}"`
        );
    }

    return { text, userId, userName, source };
}

export function isRequestVerifiedCreator(req: express.Request): boolean {
    if (!MU_CREATOR_TOKEN) return false;
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return false;
    return auth.slice(7).trim() === MU_CREATOR_TOKEN;
}

export function resolveCreatorIdentity(
    userId?: string,
    userName?: string
): { userId: string; userName: string } {
    return {
        userId: String(userId ?? '').trim() || DEFAULT_CREATOR_USER_ID,
        userName: String(userName ?? '').trim() || DEFAULT_CREATOR_USER_NAME,
    };
}

export function shouldForceSlowRoute(text: string): boolean {
    const t = String(text || '').trim().toLowerCase();
    return t ? FORCE_SLOW_RE.test(t) : false;
}

/**
 * Resolve all common chat context from an incoming request.
 * Returns null if the body is missing a required `text` field
 * (caller should return 400).
 */
export function resolveChatContext(req: express.Request): ChatContext | null {
    const { text, userId, userName, source } = normalizeChatBody(req.body);
    if (!text) return null;

    const isVerified = isRequestVerifiedCreator(req);
    const creatorSession = source === 'creator' && isVerified;
    const creatorIdentity = creatorSession
        ? resolveCreatorIdentity(userId, userName)
        : null;
    const forceSlowRoute = shouldForceSlowRoute(text);

    return {
        text,
        userId,
        userName,
        source,
        isVerified,
        creatorSession,
        creatorIdentity,
        forceSlowRoute,
    };
}

/**
 * Build a `RawStreamInput` from the resolved chat context.
 * Covers the common input-building logic shared by all chat endpoints.
 */
export function buildChatInput(
    ctx: ChatContext,
    processor: SignalProcessor,
    req: express.Request,
    overrides?: Partial<RawStreamInput>
): RawStreamInput {
    const input = processor.processDanmaku(
        ctx.creatorIdentity?.userId || ctx.userId || 'viewer',
        ctx.text
    );
    input.userName = ctx.creatorIdentity?.userName || ctx.userName;

    const source = ctx.source;
    if (
        (source === 'creator' || source === 'gift') &&
        (source !== 'creator' || ctx.creatorSession)
    ) {
        input.source = source as RawStreamInput['source'];
    }
    if (ctx.creatorSession) {
        input.verifiedCreator = true;
    }
    if (ctx.forceSlowRoute) {
        input.routeHint = 'slow';
    }
    input.requestId =
        (req.body?.requestId as string) ||
        (req.headers['x-request-id'] as string) ||
        input.requestId;

    if (overrides) {
        Object.assign(input, overrides);
    }

    return input;
}

/**
 * Extract request-id from a request (for error logging).
 */
export function extractRequestId(req: express.Request): string {
    return (
        (req.body?.requestId as string) ||
        (req.headers['x-request-id'] as string) ||
        'na'
    );
}

/**
 * Send a unified chat-error JSON response.
 */
export function handleChatError(
    res: express.Response,
    error: any,
    label: string,
    rid: string
): void {
    console.error(`[${label}] rid=${rid} handler failed:`, error?.message || error);
    if (error?.stack) console.error(error.stack);
    res.json({
        success: false,
        error: error?.message || 'Unknown error',
        text: CHAT_ERROR_FALLBACK,
    });
}
