import { RawStreamInput } from '../types/brain';
import { PreferenceSentiment } from '../memory';

export type CognitiveEvent = { type: 'stimulus', data: RawStreamInput };

export type ResponseRoute = 'fast' | 'slow';
export type SessionPhase = 'opening' | 'interactive' | 'closing' | 'recap';
export type ViewerTier = 'new' | 'regular' | 'core';

export type SessionGoalStatus = 'open' | 'done';

export type SessionGoal = {
    text: string;
    status: SessionGoalStatus;
    createdAt: number;
    updatedAt: number;
};

export type SessionState = {
    key: string;
    phase: SessionPhase;
    viewerTier: ViewerTier;
    turnCount: number;
    reconnectCount: number;
    lastResumeTurn: number;
    lastUserAt: number;
    lastAssistantAt: number;
    lastNudgeTurn: number;
    preferredName?: string;
    knownFacts: string[];
    goals: SessionGoal[];
    lastUserMessages: string[];
    lastReplies: string[];
    /** ???????????? A2??????? LLM ???????????? */
    sessionSummary?: string;
    /** ???????????? */
    lastSummaryTurn?: number;
    /**
     * ?????????????
     * currentTopic: ?????????????
     * currentTopicLabel: ?????????????
     * topicTurnCount: ?????????????
     * topicFatigue: 0-1 ?????????????
     * exhaustedTopics: ?????????????
     */
    currentTopic?: string;
    currentTopicLabel?: string;
    topicTurnCount: number;
    topicFatigue: number;
    exhaustedTopics: string[];
    isVerified?: boolean;
    updatedAt: number;
};

export type SessionUpdate = {
    preferredName?: string;
    facts: string[];
    goal?: string;
    preferences: Array<{
        topic: string;
        sentiment: PreferenceSentiment;
        confidence: number;
        volatile: boolean;
        sourceText?: string;
    }>;
    tasks: Array<{
        text: string;
        status: 'open' | 'done';
        confidence: number;
        source: 'creator' | 'viewer';
    }>;
};

export type ContextBudgetResult = {
    section: string;
    rawCount: number;
    selectedCount: number;
    tokensBefore: number;
    tokensAfter: number;
    hardNegativeDropped: number;
    lexicalAccepted: number;
};

export type SelfCriticResult = {
    issues: string[];
    score: number;
};

export type ToolShadowDecision = {
    needed: boolean;
    reason: string;
    tools: string[];
};

export type ToolExecutionMode = 'shadow' | 'live';
export type DialoguePolicyMode = 'hybrid' | 'neural';

export type ToolCallTrace = {
    toolId: string;
    status: 'ok' | 'error' | 'skipped';
    durationMs: number;
    content?: string;
    error?: string;
};

export type ToolExecutionResult = {
    mode: ToolExecutionMode;
    triggered: boolean;
    reason: string;
    selectedTool?: string;
    confidence?: number;
    calls: ToolCallTrace[];
};

export type ComplexityAnalysis = {
    complexity: number;
    confidence: number;
    signals: string[];
};
export type ModuleParticipationLevel = 'minimal' | 'balanced' | 'full';

export type LatencyBucket = {
    count: number;
    totalMs: number;
    maxMs: number;
    samples: number[];
};

export type DialogueStrategy = {
    intentTags: string[];
    requiresMemoryGrounding: boolean;
    requiresStateGrounding: boolean;
    stateGroundingMode: 'off' | 'best_effort' | 'strict';
    uncertaintyMode: 'off' | 'soft' | 'strict';
    requiredFacts: string[];
    forbiddenBehaviors: string[];
    styleVector: string[];
};

export type RuntimeStateEvidence = {
    available: boolean;
    source: 'manager' | 'local' | 'none';
    fetchedAt: number;
    serviceStates: Record<string, 'running' | 'stopped' | 'unknown'>;
    summary: string;
    notes: string[];
};

export type AnimeTraitProfile = 'moe_balanced' | 'tsundere_playful' | 'seiso_gentle' | 'denpa_chaotic';

export type AnimeTraitRuntime = {
    enabled: boolean;
    profile: AnimeTraitProfile;
    variation: number;
    noveltyBase: number;
};

export type ActiveTraitControl = {
    enabled: boolean;
    profile: AnimeTraitProfile;
    variation: number;
    novelty: number;
    surpriseRate: number;
    roleplayBias: number;
    directness: number;
    japaneseTokenRate: number;
};

export type CloudRuntimeMode = 'auto' | 'on' | 'off';

export type LlmProviderName = 'local' | 'deepseek' | 'unknown' | 'none' | 'bypass';

export type PolishedResponse = {
    text: string;
    provider: LlmProviderName;
};

export type CotThinking = {
    observation: string;
    intent_analysis: string;
    social_strategy: string;
    confidence?: number;
};

export type CotPayload = {
    thinking: CotThinking;
    response: string;
    meta?: {
        language?: string;
        safety?: {
            risk?: string;
            notes?: string;
        };
        [key: string]: any;
    };
};

export type CotTraceRecord = {
    timestamp: string;
    requestId?: string;
    userId?: string;
    userName?: string;
    source?: string;
    route?: ResponseRoute;
    llmProvider?: LlmProviderName;
    input_text: string;
    world_state_snapshot?: any;
    thinking?: CotThinking | null;
    response?: string | null;
    raw?: string;
    parse_ok: boolean;
    parse_error?: string | null;
};

export type CreatorEvalChatCase = {
    id: string;
    prompt: string;
    routeHint: ResponseRoute;
    maxLatencyMs: number;
    mustContainAny?: string[];
    forbiddenContains?: string[];
};

export type CreatorEvalChatCaseResult = {
    id: string;
    score: number;
    latencyMs: number;
    route: string;
    issues: string[];
    preview: string;
};
