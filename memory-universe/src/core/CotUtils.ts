/**
 * Chain-of-Thought parsing and reasoning strip utilities.
 * Pure functions extracted from SoulOrchestrator.
 */
import { CotPayload } from './OrchestratorTypes';

export function stripReasoning(text: string): string {
    let cleaned = text;

    // Remove <think>...</think> blocks (Qwen / reasoning-style models)
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    cleaned = cleaned.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();

    const openThink = cleaned.search(/<think>/i);
    if (openThink >= 0) {
        cleaned = cleaned.slice(0, openThink).trim();
    }
    const openAnalysis = cleaned.search(/<analysis>/i);
    if (openAnalysis >= 0) {
        cleaned = cleaned.slice(0, openAnalysis).trim();
    }

    cleaned = cleaned.replace(/<\/?think>/gi, '').trim();
    cleaned = cleaned.replace(/<\/?analysis>/gi, '').trim();

    // Remove leading "Thought:" / "Analysis:" style lines
    cleaned = cleaned.replace(/^(thought|thinking|analysis|reasoning|鎬濊€億鍒嗘瀽|鎺ㄧ悊|鍐呭績)\s*[:锛歕-\s].*$/gim, '').trim();

    // If there is a "final/answer" marker, keep only the final section
    const finalRegex = /(?:^|\n)\s*(final|answer|response|reply|output|答复|回答|回复|最终)\s*[:：\-]*/gi;
    let lastMatch: RegExpExecArray | null = null;
    let match: RegExpExecArray | null;
    while ((match = finalRegex.exec(cleaned)) !== null) {
        lastMatch = match;
    }
    if (lastMatch) {
        const candidate = cleaned.slice(lastMatch.index + lastMatch[0].length).trim();
        if (candidate) {
            cleaned = candidate;
        }
    }

    return cleaned;
}

/**
 * 尝试从原始 LLM 输出中解析 CoT JSON Payload。
 * - 支持 ```json``` 包裹
 * - 尽量提取第一段看起来像 JSON 的大括号块
 */
export function parseCotPayload(raw: string): { payload?: CotPayload; error?: string; rawJson?: string } {
    const source = (raw || '').trim();
    if (!source) {
        return { error: 'empty_output' };
    }

    // 鍘绘帀 Markdown ```json ``` 鍖呰Samsung
    let cleaned = source.replace(/```json/gi, '```').trim();
    cleaned = cleaned.replace(/```/g, '').trim();

    // 灏濊瘯鐩存帴鏁翠綋瑙ｆ瀽
    const tryParse = (text: string): CotPayload | null => {
        try {
            const obj = JSON.parse(text);
            if (!obj || typeof obj !== 'object') return null;
            if (typeof (obj as any).response !== 'string') return null;
            if (!(obj as any).thinking || typeof (obj as any).thinking !== 'object') return null;
            const t = (obj as any).thinking;
            if (typeof t.observation !== 'string' || typeof t.intent_analysis !== 'string' || typeof t.social_strategy !== 'string') {
                return null;
            }
            return obj as CotPayload;
        } catch {
            return null;
        }
    };

    const direct = tryParse(cleaned);
    if (direct) {
        return { payload: direct, rawJson: cleaned };
    }

    // 从文本中提取第一个 JSON 对象块
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        const candidate = cleaned.slice(firstBrace, lastBrace + 1).trim();
        const payload = tryParse(candidate);
        if (payload) {
            return { payload, rawJson: candidate };
        }
    }

    return { error: 'json_parse_failed', rawJson: cleaned };
}
