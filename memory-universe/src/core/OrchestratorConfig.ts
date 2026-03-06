/**
 * OrchestratorConfig — centralized environment configuration for SoulOrchestrator.
 *
 * All process.env parsing lives here. SoulOrchestrator receives this as a
 * dependency, making it testable and eliminating ~400 lines of inline parsing.
 *
 * Migration guide:
 *   1. Replace `this.<property>` with `this.cfg.<property>` in SoulOrchestrator
 *   2. Remove the corresponding `private readonly` declarations
 *   3. Run tsc to verify
 */

import path from 'path';

// ── Helpers ────────────────────────────────────────────────────

function readBoundedFloat(value: string | undefined, fallback: number, min = 0, max = 2): number {
    const parsed = Number.parseFloat((value || '').trim());
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function readInt(value: string | undefined, fallback: number, min = 0): number {
    return Math.max(min, Number.parseInt(value || '', 10) || fallback);
}

function readBool(value: string | undefined, defaultTrue: boolean): boolean {
    if (defaultTrue) return value !== 'false';
    return value === 'true';
}

type AnimeTraitProfile = 'moe_balanced' | 'tsundere_playful' | 'seiso_gentle' | 'denpa_chaotic';
type CloudRuntimeMode = 'auto' | 'on' | 'off';
type DialoguePolicyMode = 'hybrid' | 'neural';
type ToolExecutionMode = 'shadow' | 'live';

function normalizeAnimeTraitProfile(value: string | undefined): AnimeTraitProfile {
    const n = (value || '').trim().toLowerCase();
    if (n === 'moe_balanced' || n === 'tsundere_playful' || n === 'seiso_gentle' || n === 'denpa_chaotic') return n;
    return 'moe_balanced';
}

function normalizeCloudRuntimeMode(value: string | undefined): CloudRuntimeMode {
    const n = (value || '').trim().toLowerCase();
    if (n === 'on' || n === 'off' || n === 'auto') return n;
    return 'auto';
}

// ── Config Interface ───────────────────────────────────────────

export interface OrchestratorConfig {
    // Endpoints
    brainEndpoint: string;
    llmEndpoint: string;
    ttsEndpoint: string;
    managerEndpoint: string;

    // Identity
    personaName: string;
    creatorUserId: string;
    creatorDisplayName: string;
    creatorAliases: Set<string>;

    // Phrases
    errorPhrase: string;
    warmupPhrase: string;

    // Degraded mode
    degradedMaxTokens: number;
    degradedSkipBrainnn: boolean;
    degradedSkipOptional: boolean;
    degradedSkipTts: boolean;

    // Fast path
    fastPathEnabled: boolean;
    fastPathMaxChars: number;
    fastPathMaxTokens: number;
    fastPathHardMaxChars: number;
    fastPathSkipMemory: boolean;
    fastPathSkipAgentCore: boolean;
    fastPathSkipBrainnn: boolean;
    fastPathSkipOptional: boolean;
    fastPathSimpleComplexityThreshold: number;

    // Reply limits
    fastReplyMaxWords: number;
    slowReplyMaxWords: number;

    // LLM temperatures
    llmFastTemperature: number;
    llmSlowTemperature: number;
    llmRetryTemperature: number;
    llmFastTopP: number;
    llmSlowTopP: number;
    noveltyMinThreshold: number;
    emojiMaxCount: number;
    forceNoThink: boolean;
    promptCharsHardLimit: number;

    // CoT
    cotHardContractEnabled: boolean;
    cotTracePath: string;
    cotBadSamplePath: string;

    // Language / naming
    preferChineseByDefault: boolean;
    publicSafeNameMaxLen: number;
    publicSafeNameMaxDigitRatio: number;
    publicAddressFallbackZh: string;
    publicAddressFallbackEn: string;

    // Route thresholds
    routeComplexityThreshold: number;
    routeConfidenceThreshold: number;

    // Service timeouts
    optionalServiceTimeoutMs: number;
    fastServiceTimeoutMs: number;
    predictionFastTimeoutMs: number;
    runtimeStateTimeoutMs: number;
    inlineTtsTimeoutMs: number;
    ttsWarmupWindowMs: number;

    // Persistence
    asyncPersistenceEnabled: boolean;

    // Cloud LLM
    preferCloudOnOverload: boolean;
    slowPathCloudEnabled: boolean;
    slowPathCloudAlways: boolean;
    slowPathCloudComplexOnly: boolean;
    slowPathCloudAllowRandom: boolean;
    slowPathCloudProbability: number;
    llmCloudRuntimeMode: CloudRuntimeMode;
    useLocalLlmEnabled: boolean;

    // Live realtime
    liveRealtimeModeEnabled: boolean;
    liveSkipHeavyPostProcessing: boolean;
    liveForceLocalFast: boolean;
    liveForceLocalFastStrict: boolean;
    liveFastLlmTimeoutMs: number;
    liveSlowLlmTimeoutMs: number;
    liveFastMaxTokens: number;
    liveSlowMaxTokens: number;

    // Features
    inlineTtsEnabled: boolean;
    predictionEnabled: boolean;
    topicFatigueSuggestThreshold: number;
    topicFatigueHardThreshold: number;

    // Session / memory
    maxSessionFacts: number;
    maxCanonicalFacts: number;
    maxSessionGoals: number;
    maxSessionMessages: number;
    sessionSummaryEnabled: boolean;
    sessionSummaryEveryNTurns: number;
    sessionResumeGapMs: number;
    memoryUpdateEnabled: boolean;
    memoryUpdateSimilarityThreshold: number;
    consolidationEnabled: boolean;
    consolidationEveryNTurns: number;
    goalNudgeMinTurns: number;
    goalNudgeMaxTurns: number;
    memoryLongTermCoreMax: number;
    memoryBudgetCharsFast: number;
    memoryBudgetCharsSlow: number;
    memoryBudgetMaxEntriesFast: number;
    memoryBudgetMaxEntriesSlow: number;
    memoryAdaptiveMinScore: number;
    memoryAdaptiveRatio: number;
    memoryHardNegativeSimilarity: number;
    memoryHardNegativeLexicalMin: number;
    memoryWriteGateEnabled: boolean;
    memoryStableWriteMinConfidence: number;
    memoryVolatileWriteMinConfidence: number;
    memoryConflictOverwriteMargin: number;
    creatorMemoryTrustBoost: number;

    // Dialogue policy
    dialoguePolicyMode: DialoguePolicyMode;
    minimalSystemPromptEnabled: boolean;
    neuralModeSkipGoalDriver: boolean;
    neuralModeMinimalConsistencyGuard: boolean;
    neuralModeIncludeSessionMemory: boolean;
    honestUncertaintyEnabled: boolean;

    // Self-critic
    selfCriticEnabled: boolean;
    selfCriticRewriteEnabled: boolean;
    selfCriticRewriteOnFast: boolean;
    qualityRewriteOnFast: boolean;
    selfCriticMinScore: number;

    // Tool execution
    toolShadowModeEnabled: boolean;
    toolCallingEnabled: boolean;
    toolExecutionMode: ToolExecutionMode;
    toolExecutionTimeoutMs: number;
    toolRouteTimeoutMs: number;
    toolExecutionMaxCalls: number;
    toolRouteMinConfidence: number;
    allowedToolIds: Set<string>;

    // Anime trait
    animeTraitDefault: {
        enabled: boolean;
        profile: AnimeTraitProfile;
        variation: number;
        noveltyBase: number;
    };

    // Latency
    latencySampleCap: number;
}

// ── Factory ────────────────────────────────────────────────────

export function loadOrchestratorConfig(env: Record<string, string | undefined> = process.env): OrchestratorConfig {
    const e = (key: string) => env[key];

    const fastReplyMaxWords = readInt(e('FAST_REPLY_MAX_WORDS'), 20, 8);
    const fastPathMaxChars = readInt(e('FAST_PATH_MAX_CHARS'), 36, 20);
    const liveFastLlmTimeoutMs = Math.max(800, readInt(e('LIVE_FAST_LLM_TIMEOUT_MS'), 2200, 800));
    const liveFastMaxTokens = readInt(e('LIVE_FAST_MAX_TOKENS'), 72, 24);
    const memoryBudgetCharsFast = readInt(e('MEMORY_BUDGET_CHARS_FAST'), 180, 80);
    const memoryBudgetMaxEntriesFast = readInt(e('MEMORY_BUDGET_MAX_ENTRIES_FAST'), 2, 1);
    const goalNudgeMinTurns = readInt(e('GOAL_NUDGE_MIN_TURNS'), 3, 2);
    const maxSessionFacts = 8;

    const creatorUserId = (e('CREATOR_USER_ID') || 'Jieice').trim() || 'Jieice';
    const creatorDisplayName = (e('CREATOR_DISPLAY_NAME') || '宇杰').trim() || '宇杰';
    const aliasRaw = (e('CREATOR_USER_ALIASES') || '').split(',');
    const aliasValues = [creatorUserId, creatorDisplayName, ...aliasRaw]
        .map((v) => (v || '').toString().trim().toLowerCase())
        .filter(Boolean);

    return {
        brainEndpoint: e('BRAINNN_URL') || `http://localhost:${e('BRAINNN_PORT') || '4007'}`,
        llmEndpoint: e('LLM_URL') || 'http://localhost:4008',
        ttsEndpoint: e('TTS_SERVICE_URL') || `http://localhost:${e('TTS_SERVICE_PORT') || '4014'}`,
        managerEndpoint: e('MANAGER_URL') || `http://localhost:${e('MANAGER_PORT') || '8080'}`,

        personaName: (e('PERSONA_NAME') || '月影').trim() || '月影',
        creatorUserId,
        creatorDisplayName,
        creatorAliases: new Set(aliasValues),

        errorPhrase: e('CHAT_ERROR_MESSAGE') || '\u62b1\u6b49\uff0c\u6211\u521a\u521a\u6389\u7ebf\u4e86\uff0c\u8bf7\u518d\u8bf4\u4e00\u6b21\u3002',
        warmupPhrase: e('WARMUP_MESSAGE') || '\u7cfb\u7edf\u6b63\u5728\u9884\u70ed\uff0c\u8bf7\u7a0d\u7b49\u4e00\u4e0b\u3002',

        degradedMaxTokens: readInt(e('RESOURCE_DEGRADED_MAX_TOKENS'), 120, 20),
        degradedSkipBrainnn: readBool(e('RESOURCE_DEGRADED_SKIP_BRAINNN'), true),
        degradedSkipOptional: readBool(e('RESOURCE_DEGRADED_SKIP_OPTIONAL'), true),
        degradedSkipTts: e('RESOURCE_DEGRADED_SKIP_TTS') === 'true',

        fastPathEnabled: readBool(e('FAST_PATH_ENABLED'), true),
        fastPathMaxChars,
        fastPathMaxTokens: readInt(e('LLM_FAST_MAX_TOKENS'), 96, 20),
        fastPathHardMaxChars: Math.max(fastPathMaxChars, readInt(e('FAST_PATH_MAX_CHARS_HARD'), 96, fastPathMaxChars)),
        fastPathSkipMemory: readBool(e('FAST_PATH_SKIP_MEMORY'), true),
        fastPathSkipAgentCore: readBool(e('FAST_PATH_SKIP_AGENT_CORE'), true),
        fastPathSkipBrainnn: readBool(e('FAST_PATH_SKIP_BRAINNN'), true),
        fastPathSkipOptional: readBool(e('FAST_PATH_SKIP_OPTIONAL'), true),
        fastPathSimpleComplexityThreshold: readBoundedFloat(e('FAST_PATH_SIMPLE_COMPLEXITY_THRESHOLD'), 0.22, 0, 1),

        fastReplyMaxWords,
        slowReplyMaxWords: Math.max(fastReplyMaxWords, readInt(e('SLOW_REPLY_MAX_WORDS'), 50, fastReplyMaxWords)),

        llmFastTemperature: readBoundedFloat(e('LLM_FAST_TEMPERATURE'), 0.55),
        llmSlowTemperature: readBoundedFloat(e('LLM_SLOW_TEMPERATURE'), 0.7),
        llmRetryTemperature: readBoundedFloat(e('LLM_RETRY_TEMPERATURE'), 0.35),
        llmFastTopP: readBoundedFloat(e('LLM_FAST_TOP_P'), 0.82, 0.2, 1),
        llmSlowTopP: readBoundedFloat(e('LLM_SLOW_TOP_P'), 0.9, 0.2, 1),
        noveltyMinThreshold: readBoundedFloat(e('LLM_NOVELTY_MIN_THRESHOLD'), 0.42, 0, 1),
        emojiMaxCount: Math.max(0, readInt(e('LLM_REPLY_EMOJI_MAX'), 0, 0)),
        forceNoThink: readBool(e('LLM_FORCE_NO_THINK'), true),
        promptCharsHardLimit: readInt(e('LLM_PROMPT_CHARS_HARD_LIMIT'), 3600, 800),

        cotHardContractEnabled: e('COT_JSON_HARD_CONTRACT_ENABLED') === 'true',
        cotTracePath: path.resolve(process.cwd(), e('COT_TRACE_PATH') || '../data/traces/cot_traces.jsonl'),
        cotBadSamplePath: path.resolve(process.cwd(), e('COT_BAD_TRACE_PATH') || '../data/traces/bad_cot_samples.jsonl'),

        preferChineseByDefault: readBool(e('REPLY_PREFER_CHINESE_DEFAULT'), true),
        publicSafeNameMaxLen: readInt(e('PUBLIC_SAFE_NAME_MAX_LEN'), 18, 8),
        publicSafeNameMaxDigitRatio: readBoundedFloat(e('PUBLIC_SAFE_NAME_MAX_DIGIT_RATIO'), 0.5, 0, 1),
        publicAddressFallbackZh: (e('PUBLIC_ADDRESS_FALLBACK_ZH') || '这位朋友').trim() || '这位朋友',
        publicAddressFallbackEn: (e('PUBLIC_ADDRESS_FALLBACK_EN') || 'friend').trim() || 'friend',

        routeComplexityThreshold: readBoundedFloat(e('ROUTE_COMPLEXITY_THRESHOLD'), 0.52, 0, 1),
        routeConfidenceThreshold: readBoundedFloat(e('ROUTE_CONFIDENCE_THRESHOLD'), 0.58, 0, 1),

        optionalServiceTimeoutMs: readInt(e('OPTIONAL_SERVICE_TIMEOUT_MS'), 2000, 400),
        fastServiceTimeoutMs: readInt(e('FAST_SERVICE_TIMEOUT_MS'), 900, 250),
        predictionFastTimeoutMs: readInt(e('PREDICTION_TIMEOUT_FAST_MS'), 700, 250),
        runtimeStateTimeoutMs: readInt(e('RUNTIME_STATE_TIMEOUT_MS'), 1800, 600),
        inlineTtsTimeoutMs: readInt(e('INLINE_TTS_TIMEOUT_MS'), 10000, 800),
        ttsWarmupWindowMs: readInt(e('TTS_WARMUP_WINDOW_MS'), 60000, 0),

        asyncPersistenceEnabled: readBool(e('ASYNC_PERSISTENCE_ENABLED'), true),

        preferCloudOnOverload: e('LLM_PREFER_CLOUD_ON_OVERLOAD') === 'true',
        slowPathCloudEnabled: readBool(e('SLOW_PATH_CLOUD_ENABLED'), true),
        slowPathCloudAlways: e('SLOW_PATH_CLOUD_ALWAYS') === 'true',
        slowPathCloudComplexOnly: readBool(e('SLOW_PATH_CLOUD_COMPLEX_ONLY'), true),
        slowPathCloudAllowRandom: e('SLOW_PATH_CLOUD_ALLOW_RANDOM') === 'true',
        slowPathCloudProbability: readBoundedFloat(e('SLOW_PATH_CLOUD_PROBABILITY'), 0.2, 0, 1),
        llmCloudRuntimeMode: normalizeCloudRuntimeMode(e('LLM_CLOUD_RUNTIME_MODE')),
        useLocalLlmEnabled: e('USE_LOCAL_LLM') === 'true',

        liveRealtimeModeEnabled: readBool(e('LIVE_REALTIME_MODE'), true),
        liveSkipHeavyPostProcessing: readBool(e('LIVE_SKIP_HEAVY_POST'), true),
        liveForceLocalFast: e('LIVE_FORCE_LOCAL_FAST') === 'true',
        liveForceLocalFastStrict: e('LIVE_FORCE_LOCAL_FAST_STRICT') === 'true',
        liveFastLlmTimeoutMs,
        liveSlowLlmTimeoutMs: Math.max(liveFastLlmTimeoutMs, readInt(e('LIVE_SLOW_LLM_TIMEOUT_MS'), 4200, liveFastLlmTimeoutMs)),
        liveFastMaxTokens,
        liveSlowMaxTokens: Math.max(liveFastMaxTokens, readInt(e('LIVE_SLOW_MAX_TOKENS'), 128, liveFastMaxTokens)),

        inlineTtsEnabled: e('MU_INLINE_TTS_ENABLED') === 'true',
        predictionEnabled: e('PREDICTION_ENABLED') === 'true',
        topicFatigueSuggestThreshold: readBoundedFloat(e('TOPIC_FATIGUE_SUGGEST_THRESHOLD'), 0.65, 0, 1),
        topicFatigueHardThreshold: readBoundedFloat(e('TOPIC_FATIGUE_HARD_THRESHOLD'), 0.85, 0, 1),

        maxSessionFacts,
        maxCanonicalFacts: Math.max(maxSessionFacts, readInt(e('MEMORY_CANON_MAX_FACTS'), 16, maxSessionFacts)),
        maxSessionGoals: 3,
        maxSessionMessages: readInt(e('SESSION_MAX_MESSAGES'), 10, 6),
        sessionSummaryEnabled: readBool(e('SESSION_SUMMARY_ENABLED'), true),
        sessionSummaryEveryNTurns: readInt(e('SESSION_SUMMARY_EVERY_N_TURNS'), 4, 2),
        sessionResumeGapMs: readInt(e('SESSION_RESUME_GAP_MS'), 600000, 60000),
        memoryUpdateEnabled: readBool(e('MEMORY_UPDATE_ENABLED'), true),
        memoryUpdateSimilarityThreshold: Math.max(0.85, Math.min(0.98, parseFloat(e('MEMORY_UPDATE_SIMILARITY_THRESHOLD') || '0.90') || 0.90)),
        consolidationEnabled: readBool(e('CONSOLIDATION_ENABLED'), true),
        consolidationEveryNTurns: readInt(e('CONSOLIDATION_EVERY_N_TURNS'), 6, 2),
        goalNudgeMinTurns,
        goalNudgeMaxTurns: Math.max(goalNudgeMinTurns, readInt(e('GOAL_NUDGE_MAX_TURNS'), 5, goalNudgeMinTurns)),
        memoryLongTermCoreMax: readInt(e('MEMORY_LONGTERM_CORE_MAX'), 2, 0),
        memoryBudgetCharsFast,
        memoryBudgetCharsSlow: Math.max(memoryBudgetCharsFast, readInt(e('MEMORY_BUDGET_CHARS_SLOW'), 720, memoryBudgetCharsFast)),
        memoryBudgetMaxEntriesFast,
        memoryBudgetMaxEntriesSlow: Math.max(memoryBudgetMaxEntriesFast, readInt(e('MEMORY_BUDGET_MAX_ENTRIES_SLOW'), 5, memoryBudgetMaxEntriesFast)),
        memoryAdaptiveMinScore: readBoundedFloat(e('MEMORY_ADAPTIVE_MIN_SCORE'), 0.35, 0, 1),
        memoryAdaptiveRatio: readBoundedFloat(e('MEMORY_ADAPTIVE_RATIO'), 0.82, 0, 1),
        memoryHardNegativeSimilarity: readBoundedFloat(e('MEMORY_HARD_NEGATIVE_SIMILARITY'), 0.32, 0, 1),
        memoryHardNegativeLexicalMin: readBoundedFloat(e('MEMORY_HARD_NEGATIVE_LEXICAL_MIN'), 0.08, 0, 1),
        memoryWriteGateEnabled: readBool(e('MEMORY_WRITE_GATE_ENABLED'), true),
        memoryStableWriteMinConfidence: readBoundedFloat(e('MEMORY_STABLE_WRITE_MIN_CONFIDENCE'), 0.78, 0, 1),
        memoryVolatileWriteMinConfidence: readBoundedFloat(e('MEMORY_VOLATILE_WRITE_MIN_CONFIDENCE'), 0.56, 0, 1),
        memoryConflictOverwriteMargin: readBoundedFloat(e('MEMORY_CONFLICT_OVERWRITE_MARGIN'), 0.08, 0, 0.5),
        creatorMemoryTrustBoost: readBoundedFloat(e('CREATOR_MEMORY_TRUST_BOOST'), 0.08, 0, 0.25),

        dialoguePolicyMode: ((e('DIALOGUE_POLICY_MODE') || 'hybrid').trim().toLowerCase() === 'neural') ? 'neural' : 'hybrid',
        minimalSystemPromptEnabled: readBool(e('LLM_MINIMAL_SYSTEM_PROMPT'), true),
        neuralModeSkipGoalDriver: readBool(e('NEURAL_MODE_SKIP_GOAL_DRIVER'), true),
        neuralModeMinimalConsistencyGuard: readBool(e('NEURAL_MODE_MINIMAL_CONSISTENCY_GUARD'), true),
        neuralModeIncludeSessionMemory: e('NEURAL_MODE_INCLUDE_SESSION_MEMORY') === 'true',
        honestUncertaintyEnabled: readBool(e('HONEST_UNCERTAINTY_ENABLED'), true),

        selfCriticEnabled: readBool(e('SELF_CRITIC_ENABLED'), true),
        selfCriticRewriteEnabled: readBool(e('SELF_CRITIC_REWRITE_ENABLED'), true),
        selfCriticRewriteOnFast: e('SELF_CRITIC_REWRITE_ON_FAST') === 'true',
        qualityRewriteOnFast: e('QUALITY_REWRITE_ON_FAST') === 'true',
        selfCriticMinScore: readBoundedFloat(e('SELF_CRITIC_MIN_SCORE'), 0.62, 0, 1),

        toolShadowModeEnabled: readBool(e('TOOL_SHADOW_MODE_ENABLED'), true),
        toolCallingEnabled: readBool(e('TOOL_CALLING_ENABLED'), true),
        toolExecutionMode: ((e('TOOL_EXECUTION_MODE') || 'shadow').trim().toLowerCase() === 'live') ? 'live' : 'shadow',
        toolExecutionTimeoutMs: readInt(e('TOOL_EXECUTION_TIMEOUT_MS') || e('TOOL_DEFAULT_TIMEOUT'), 3000, 800),
        toolRouteTimeoutMs: readInt(e('TOOL_ROUTE_TIMEOUT_MS'), 1500, 500),
        toolExecutionMaxCalls: readInt(e('TOOL_CALLING_MAX_CALLS'), 1, 1),
        toolRouteMinConfidence: readBoundedFloat(e('TOOL_ROUTE_MIN_CONFIDENCE') || e('TOOL_MIN_CONFIDENCE'), 0.35, 0, 1),
        allowedToolIds: new Set(
            ((e('TOOL_EXECUTION_ALLOWED_TOOLS') || 'datetime,calculator,random').trim() || 'datetime,calculator,random')
                .split(',').map((v) => v.trim()).filter(Boolean)
        ),

        animeTraitDefault: {
            enabled: readBool(e('ANIME_TRAIT_ENABLED'), true),
            profile: normalizeAnimeTraitProfile(e('ANIME_TRAIT_PROFILE')),
            variation: readBoundedFloat(e('ANIME_TRAIT_VARIATION'), 0.35, 0, 1),
            noveltyBase: readBoundedFloat(e('ANIME_TRAIT_NOVELTY_BASE'), 0.42, 0, 1),
        },

        latencySampleCap: readInt(e('LATENCY_SAMPLE_CAP'), 240, 20),
    };
}
