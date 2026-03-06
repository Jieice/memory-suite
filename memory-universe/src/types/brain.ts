/**
 * Core type definitions aligned with BrainNN service responses.
 */

export interface WorldState {
    activity?: string;
    atmosphere?: number;
    hot_topics?: string[];
    danmaku_density?: number;
}

export interface SoulState {
    emotions: number[];
    personality: number[];
    motivation: number[];
    world?: WorldState;
}

export interface BrainSignal {
    text: string;
    policy: number[];
    actions: number[];
    soul?: {
        emotion: { [key: string]: number };
        drives: { [key: string]: number };
        personality: string;
    };
    mood_instruction?: string;
    style_guidance?: {
        tone?: string;
        pacing?: string;
        interaction_goal?: string;
        avoid_phrases?: string[];
        expressiveness?: number;
        kawaii_ratio?: number;
        surprise_bias?: number;
        roleplay_bias?: number;
        japanese_token_rate?: number;
    };
    reply_constraints?: {
        max_sentences?: number;
        max_chars_zh?: number;
        max_words_en?: number;
    };
    trait_runtime?: {
        enabled?: boolean;
        profile?: string;
        variation?: number;
        novelty_base?: number;
    };
    trait_signal?: {
        enabled?: boolean;
        profile?: string;
        style_vector?: {
            tone_hint?: string;
            kawaii_ratio?: number;
            expressiveness?: number;
            tsundere_bias?: number;
            chaos_bias?: number;
            intimacy_bias?: number;
            directness?: number;
        };
        response_policy?: {
            novelty_target?: number;
            surprise_rate?: number;
            roleplay_bias?: number;
            japanese_token_rate?: number;
        };
        lora_hint?: {
            target_style_tag?: string;
            weight_suggestion?: number;
        };
        guardrails?: {
            ban_meta_assistant_style?: boolean;
            ban_creator_claim_for_public?: boolean;
        };
    };
}

export interface RawStreamInput {
    content: string;
    source: 'danmaku' | 'gift' | 'creator';
    userId?: string;
    userName?: string;
    requestId?: string;
    routeHint?: 'fast' | 'slow';
    processingMode?: 'foreground' | 'background';
    features: {
        intensity: number;
        sentiment_hint: number;
        timestamp: number;
    };
    visual_emb?: number[];
    verifiedCreator?: boolean;
}

export interface PersonaStateLegacy {
    emotionBaseline: number;
    energyLevel: number;
    styleWeights: {
        playful: number;
        serious: number;
        caring: number;
        chaotic: number;
    };
    creatorIntimacy: number;
    viewerWarmth: number;
}
