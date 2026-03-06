import { EventEmitter } from 'events';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Subject } from 'rxjs';
import { map, filter, mergeMap, tap, share } from 'rxjs/operators';
import { RawStreamInput, BrainSignal, SoulState, PersonaStateLegacy } from '../types/brain';
import {
    VectorStore,
    MemoryEncoder,
    MemoryRetriever,
    DreamingService,
    MemoryContext,
    CanonicalMemoryStore,
    CanonicalPreference,
    CanonicalTask,
    PreferenceSentiment,
    getRetrievalStats
} from '../memory';
import { getGlobalLLMFallbackHandler } from '../llm/LLMFallbackHandler';
import { isFallbackResponse } from '../../../shared/FallbackTemplate';
import { runWithTTSCircuitBreaker } from '../../../shared/CircuitBreakerClient';
import { ResourceGuard } from './ResourceGuard';
import { loadOrchestratorConfig, type OrchestratorConfig } from './OrchestratorConfig';
import { getControlManager } from './ControlManager';
import { getEvoMemory, EvoMemorySystem, Experience } from '../memory/EvoMemorySystem';
import { getMem0, Mem0StyleMemory, Fact } from '../memory/Mem0StyleMemory';
import { getVisionService, VisionService } from '../memory/VisionService';
import { getVisualMemoryStore, VisualMemoryStore } from '../memory/VisualMemoryStore';
import { getTransparentMemory, TransparentMemory } from '../memory/TransparentMemory';
import { getMemoryR1, MemoryR1 } from '../memory/MemoryR1';
import {
    CognitiveEvent,
    ResponseRoute,
    SessionPhase,
    ViewerTier,
    SessionGoalStatus,
    SessionGoal,
    SessionState,
    SessionUpdate,
    ContextBudgetResult,
    SelfCriticResult,
    ToolShadowDecision,
    ToolExecutionMode,
    DialoguePolicyMode,
    ToolCallTrace,
    ToolExecutionResult,
    ComplexityAnalysis,
    ModuleParticipationLevel,
    LatencyBucket,
    DialogueStrategy,
    RuntimeStateEvidence,
    AnimeTraitProfile,
    AnimeTraitRuntime,
    ActiveTraitControl,
    CloudRuntimeMode,
    LlmProviderName,
    PolishedResponse,
    CotThinking,
    CotPayload,
    CotTraceRecord,
    CreatorEvalChatCase,
    CreatorEvalChatCaseResult,
} from './OrchestratorTypes';

import { InlineAgentCore } from './InlineAgentCore';
import { InlineRuleEngine } from './InlineRuleEngine';
import { MetricsService } from './MetricsService';
import * as TA from './TextAnalysis';
import { stripReasoning, parseCotPayload } from './CotUtils';
import { generateVoiceParams } from './VoiceParams';

export class SoulOrchestrator extends EventEmitter {
    private readonly metrics = new MetricsService(loadOrchestratorConfig().latencySampleCap);

    private static readBoundedFloat(value: string | undefined, fallback: number, min = 0, max = 2): number {
        const parsed = Number.parseFloat((value || '').trim());
        if (Number.isNaN(parsed)) return fallback;
        return Math.min(max, Math.max(min, parsed));
    }

    private readonly cfg = loadOrchestratorConfig();

    private readonly brainEndpoint = this.cfg.brainEndpoint;
    private readonly llmEndpoint = this.cfg.llmEndpoint;
    private readonly ttsEndpoint = this.cfg.ttsEndpoint;
    private lastSoulState: SoulState | null = null;
    
    // 内联模块
    private inlineAgentCore: InlineAgentCore = new InlineAgentCore();
    private inlineRuleEngine: InlineRuleEngine = new InlineRuleEngine();
    private readonly errorPhrase = this.cfg.errorPhrase;
    private readonly personaName = this.cfg.personaName;
    private readonly creatorUserId = this.cfg.creatorUserId;
    private readonly creatorDisplayName = this.cfg.creatorDisplayName;
    private readonly creatorAliases = this.cfg.creatorAliases;
    private readonly warmupPhrase = this.cfg.warmupPhrase;
    private readonly degradedMaxTokens = this.cfg.degradedMaxTokens;
    private readonly degradedSkipBrainnn = this.cfg.degradedSkipBrainnn;
    private readonly degradedSkipOptional = this.cfg.degradedSkipOptional;
    private readonly degradedSkipTts = this.cfg.degradedSkipTts;
    private readonly fastPathEnabled = this.cfg.fastPathEnabled;
    private readonly fastPathMaxChars = this.cfg.fastPathMaxChars;
    private readonly fastPathMaxTokens = this.cfg.fastPathMaxTokens;
    private readonly fastReplyMaxWords = this.cfg.fastReplyMaxWords;
    private readonly slowReplyMaxWords = this.cfg.slowReplyMaxWords;
    private readonly llmFastTemperature = this.cfg.llmFastTemperature;
    private readonly llmSlowTemperature = this.cfg.llmSlowTemperature;
    private readonly llmRetryTemperature = this.cfg.llmRetryTemperature;
    private readonly llmFastTopP = this.cfg.llmFastTopP;
    private readonly llmSlowTopP = this.cfg.llmSlowTopP;
    private readonly noveltyMinThreshold = this.cfg.noveltyMinThreshold;
    private readonly emojiMaxCount = this.cfg.emojiMaxCount;
    private readonly cotHardContractEnabled = this.cfg.cotHardContractEnabled;
    private readonly cotTracePath = this.cfg.cotTracePath;
    private readonly cotBadSamplePath = this.cfg.cotBadSamplePath;
    private readonly preferChineseByDefault = this.cfg.preferChineseByDefault;
    private readonly publicSafeNameMaxLen = this.cfg.publicSafeNameMaxLen;
    private readonly publicSafeNameMaxDigitRatio = this.cfg.publicSafeNameMaxDigitRatio;
    private readonly publicAddressFallbackZh = this.cfg.publicAddressFallbackZh;
    private readonly publicAddressFallbackEn = this.cfg.publicAddressFallbackEn;
    private readonly promptCharsHardLimit = this.cfg.promptCharsHardLimit;
    private readonly forceNoThink = this.cfg.forceNoThink;
    private readonly fastPathSkipMemory = this.cfg.fastPathSkipMemory;
    private readonly fastPathSkipAgentCore = this.cfg.fastPathSkipAgentCore;
    private readonly fastPathSkipBrainnn = this.cfg.fastPathSkipBrainnn;
    private readonly fastPathSkipOptional = this.cfg.fastPathSkipOptional;
    private readonly fastPathSimpleComplexityThreshold = this.cfg.fastPathSimpleComplexityThreshold;
    private readonly fastPathHardMaxChars = this.cfg.fastPathHardMaxChars;
    private readonly routeComplexityThreshold = this.cfg.routeComplexityThreshold;
    private readonly routeConfidenceThreshold = this.cfg.routeConfidenceThreshold;
    private readonly optionalServiceTimeoutMs = this.cfg.optionalServiceTimeoutMs;
    private readonly fastServiceTimeoutMs = this.cfg.fastServiceTimeoutMs;
    private readonly predictionFastTimeoutMs = this.cfg.predictionFastTimeoutMs;
    private readonly runtimeStateTimeoutMs = this.cfg.runtimeStateTimeoutMs;
    private readonly inlineTtsTimeoutMs = this.cfg.inlineTtsTimeoutMs;
    private readonly asyncPersistenceEnabled = this.cfg.asyncPersistenceEnabled;
    private readonly preferCloudOnOverload = this.cfg.preferCloudOnOverload;
    private readonly slowPathCloudEnabled = this.cfg.slowPathCloudEnabled;
    private readonly slowPathCloudAlways = this.cfg.slowPathCloudAlways;
    private readonly slowPathCloudComplexOnly = this.cfg.slowPathCloudComplexOnly;
    private readonly slowPathCloudAllowRandom = this.cfg.slowPathCloudAllowRandom;
    private readonly slowPathCloudProbability = this.cfg.slowPathCloudProbability;
    private readonly liveRealtimeModeEnabled = this.cfg.liveRealtimeModeEnabled;
    private readonly liveSkipHeavyPostProcessing = this.cfg.liveSkipHeavyPostProcessing;
    private readonly liveForceLocalFast = this.cfg.liveForceLocalFast;
    private readonly liveForceLocalFastStrict = this.cfg.liveForceLocalFastStrict;
    private readonly useLocalLlmEnabled = this.cfg.useLocalLlmEnabled;
    private readonly liveFastLlmTimeoutMs = this.cfg.liveFastLlmTimeoutMs;
    private readonly liveSlowLlmTimeoutMs = this.cfg.liveSlowLlmTimeoutMs;
    private readonly liveFastMaxTokens = this.cfg.liveFastMaxTokens;
    private readonly liveSlowMaxTokens = this.cfg.liveSlowMaxTokens;
    private llmCloudRuntimeMode = this.cfg.llmCloudRuntimeMode;
    private readonly inlineTtsEnabled = this.cfg.inlineTtsEnabled;
    private readonly predictionEnabled = this.cfg.predictionEnabled;
    private readonly topicFatigueSuggestThreshold = this.cfg.topicFatigueSuggestThreshold;
    private readonly topicFatigueHardThreshold = this.cfg.topicFatigueHardThreshold;
    private readonly resourceGuard: ResourceGuard;
    private readonly ttsWarmupWindowMs = this.cfg.ttsWarmupWindowMs;
    private ttsWarmupStart = Date.now();
    private ttsWarmupLogged = false;

    // --- Phase 2: 记忆系统 ---
    private vectorStore: VectorStore;
    private memoryEncoder: MemoryEncoder;
    private memoryRetriever: MemoryRetriever;
    private dreamingService: DreamingService;
    private canonicalMemory: CanonicalMemoryStore;
    private memoryEnabled: boolean = true;
    private evoMemory: EvoMemorySystem;
    private mem0: Mem0StyleMemory;
    private visionService: VisionService;
    private visualMemoryStore: VisualMemoryStore;
    private transparentMemory: TransparentMemory;
    private memoryR1: MemoryR1;
    private sessionState = new Map<string, SessionState>();
    private readonly maxSessionFacts = this.cfg.maxSessionFacts;
    private readonly maxCanonicalFacts = this.cfg.maxCanonicalFacts;
    private readonly maxSessionGoals = this.cfg.maxSessionGoals;
    private readonly maxSessionMessages = this.cfg.maxSessionMessages;
    private readonly sessionSummaryEnabled = this.cfg.sessionSummaryEnabled;
    private readonly sessionSummaryEveryNTurns = this.cfg.sessionSummaryEveryNTurns;
    private readonly memoryUpdateEnabled = this.cfg.memoryUpdateEnabled;
    private readonly memoryUpdateSimilarityThreshold = this.cfg.memoryUpdateSimilarityThreshold;
    private readonly consolidationEnabled = this.cfg.consolidationEnabled;
    private readonly consolidationEveryNTurns = this.cfg.consolidationEveryNTurns;
    private readonly sessionResumeGapMs = this.cfg.sessionResumeGapMs;
    private readonly goalNudgeMinTurns = this.cfg.goalNudgeMinTurns;
    private readonly goalNudgeMaxTurns = this.cfg.goalNudgeMaxTurns;
    private readonly dialoguePolicyMode: DialoguePolicyMode = this.cfg.dialoguePolicyMode;
    private readonly minimalSystemPromptEnabled = this.cfg.minimalSystemPromptEnabled;
    private readonly neuralModeSkipGoalDriver = this.cfg.neuralModeSkipGoalDriver;
    private readonly neuralModeMinimalConsistencyGuard = this.cfg.neuralModeMinimalConsistencyGuard;
    private readonly neuralModeIncludeSessionMemory = this.cfg.neuralModeIncludeSessionMemory;
    private readonly honestUncertaintyEnabled = this.cfg.honestUncertaintyEnabled;
    private readonly toolShadowModeEnabled = this.cfg.toolShadowModeEnabled;
    private readonly managerEndpoint = this.cfg.managerEndpoint;
    private readonly toolExecutionMode: ToolExecutionMode = this.cfg.toolExecutionMode;
    private readonly toolCallingEnabled = this.cfg.toolCallingEnabled;
    private readonly toolExecutionTimeoutMs = this.cfg.toolExecutionTimeoutMs;
    private readonly toolRouteTimeoutMs = this.cfg.toolRouteTimeoutMs;
    private readonly toolExecutionMaxCalls = this.cfg.toolExecutionMaxCalls;
    private readonly toolRouteMinConfidence = this.cfg.toolRouteMinConfidence;
    private readonly allowedToolIds = this.cfg.allowedToolIds;
    private readonly animeTraitProfiles: ReadonlyArray<AnimeTraitProfile> = [
        'moe_balanced',
        'tsundere_playful',
        'seiso_gentle',
        'denpa_chaotic'
    ];
    private readonly animeTraitDefault: AnimeTraitRuntime = this.cfg.animeTraitDefault;
    private animeTraitRuntime: AnimeTraitRuntime = { ...this.animeTraitDefault };
    private readonly memoryLongTermCoreMax = this.cfg.memoryLongTermCoreMax;
    private readonly selfCriticEnabled = this.cfg.selfCriticEnabled;
    private readonly selfCriticRewriteEnabled = this.cfg.selfCriticRewriteEnabled;
    private readonly selfCriticRewriteOnFast = this.cfg.selfCriticRewriteOnFast;
    private readonly qualityRewriteOnFast = this.cfg.qualityRewriteOnFast;
    private readonly selfCriticMinScore = this.cfg.selfCriticMinScore;
    private readonly memoryBudgetCharsFast = this.cfg.memoryBudgetCharsFast;
    private readonly memoryBudgetCharsSlow = this.cfg.memoryBudgetCharsSlow;
    private readonly memoryBudgetMaxEntriesFast = this.cfg.memoryBudgetMaxEntriesFast;
    private readonly memoryBudgetMaxEntriesSlow = this.cfg.memoryBudgetMaxEntriesSlow;
    private readonly memoryAdaptiveMinScore = this.cfg.memoryAdaptiveMinScore;
    private readonly memoryAdaptiveRatio = this.cfg.memoryAdaptiveRatio;
    private readonly memoryHardNegativeSimilarity = this.cfg.memoryHardNegativeSimilarity;
    private readonly memoryHardNegativeLexicalMin = this.cfg.memoryHardNegativeLexicalMin;
    private readonly memoryWriteGateEnabled = this.cfg.memoryWriteGateEnabled;
    private readonly memoryStableWriteMinConfidence = this.cfg.memoryStableWriteMinConfidence;
    private readonly memoryVolatileWriteMinConfidence = this.cfg.memoryVolatileWriteMinConfidence;
    private readonly memoryConflictOverwriteMargin = this.cfg.memoryConflictOverwriteMargin;
    private readonly creatorMemoryTrustBoost = this.cfg.creatorMemoryTrustBoost;
    // --- RxJS Streams ---
    private stimulus$ = new Subject<RawStreamInput>();
    public readonly output$ = new Subject<any>();

    private syncWorldStateInterval: NodeJS.Timeout | null = null;

    private async syncWorldStateToBrain(): Promise<void> {
        try {
            const hotTopics = Array.from(this.metrics.routeReasonStats.keys()).slice(-5);
            const atmosphere = Math.min(1.0, (this.metrics.consistencyStats.total / 50.0)); // ????????????            
            await axios.post(`${this.brainEndpoint}/world/update`, {
                activity: this.lastSoulState?.world?.activity || "????",
                atmosphere: atmosphere,
                hot_topics: hotTopics,
                danmaku_density: this.metrics.consistencyStats.total / 10.0 // ?????????????
            }, { timeout: 1000 });
        } catch (e) {
            // ????????????
        }
    }

    private startWorldSync(): void {
        if (this.syncWorldStateInterval) return;
        this.syncWorldStateInterval = setInterval(() => this.syncWorldStateToBrain(), 10000);
    }

    private ensureRequestId(input: RawStreamInput): string {
        if (input.requestId && input.requestId.trim()) {
            return input.requestId;
        }
        const rid = `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        input.requestId = rid;
        return rid;
    }

    constructor() {
        super();

        this.resourceGuard = new ResourceGuard({
            enabled: process.env.RESOURCE_GUARD_ENABLED !== 'false',
            cpuThreshold: Number.parseFloat(process.env.RESOURCE_CPU_MAX || '85') || 85,
            memThreshold: Number.parseFloat(process.env.RESOURCE_MEM_MAX || '90') || 90,
            sampleIntervalMs: Number.parseInt(process.env.RESOURCE_SAMPLE_MS || '1000', 10) || 1000
        });
        this.resourceGuard.start();

        this.vectorStore = new VectorStore();
        this.memoryEncoder = new MemoryEncoder();
        this.memoryRetriever = new MemoryRetriever(this.vectorStore);
        this.dreamingService = new DreamingService(this.vectorStore, this.memoryEncoder, {
            runOnStartup: process.env.DREAMING_RUN_ON_STARTUP !== 'false',
            runOnShutdown: process.env.DREAMING_RUN_ON_SHUTDOWN === 'true',
            runEveryNTurns: Number.parseInt(process.env.DREAMING_RUN_EVERY_N_TURNS || '0', 10) || 0
        });
        const canonPath = (process.env.MEMORY_CANON_PATH || '').trim();
        this.canonicalMemory = new CanonicalMemoryStore({
            ...(canonPath ? { filePath: canonPath } : {}),
            maxFactsPerUser: this.maxCanonicalFacts
        });
        this.dreamingService.start();

        this.evoMemory = getEvoMemory();
        this.mem0 = getMem0();
        this.visionService = getVisionService();
        this.visualMemoryStore = getVisualMemoryStore();
        this.transparentMemory = getTransparentMemory();
        this.memoryR1 = getMemoryR1();

        this.startWorldSync();
        this.initializeCognitiveStream();
        console.log('[Init] SoulOrchestrator initialized');
        console.log('[Init] ???????????? enabled');
        console.log(`[Init] Canon memory: ${JSON.stringify(this.canonicalMemory.getStats())}`);
        console.log(`[Init] EvoMemory: ${JSON.stringify(this.evoMemory.getStats())}`);
        console.log(`[Init] Mem0: ${JSON.stringify(this.mem0.getStats())}`);
        console.log(`[Init] Vision: ${JSON.stringify(this.visionService.getStatus())}`);
        console.log(`[Init] VisualMemory: ${JSON.stringify(this.visualMemoryStore.getStats())}`);
        console.log(`[Init] TransparentMemory: ${JSON.stringify(this.transparentMemory.getStats())}`);
        console.log(`[Init] MemoryR1: ${JSON.stringify(this.memoryR1.getStats())}`);
        console.log(`[Init] Inline TTS for /api/chat: ${this.inlineTtsEnabled ? 'enabled' : 'disabled'}`);
        console.log(`[Init] Dialogue policy mode: ${this.dialoguePolicyMode} (minimalPrompt=${this.minimalSystemPromptEnabled}, neuralSkipGoal=${this.neuralModeSkipGoalDriver}, neuralMinimalGuard=${this.neuralModeMinimalConsistencyGuard}, neuralSessionMemory=${this.neuralModeIncludeSessionMemory})`);
        const key = (process.env.DEEPSEEK_API_KEY || '').trim();
        const keyMasked = key ? `${key.slice(0, 6)}...${key.slice(-4)}` : '(empty)';
        console.log(`[Init] Cloud route config: enabled=${this.slowPathCloudEnabled}, always=${this.slowPathCloudAlways}, complexOnly=${this.slowPathCloudComplexOnly}, allowRandom=${this.slowPathCloudAllowRandom}, key=${keyMasked}`);
        console.log(`[Init] Cloud runtime mode: ${this.llmCloudRuntimeMode}`);
        console.log(`[Init] Live realtime mode: enabled=${this.liveRealtimeModeEnabled}, skipHeavyPost=${this.liveSkipHeavyPostProcessing}, forceLocalFast=${this.liveForceLocalFast && this.useLocalLlmEnabled}, forceLocalFastStrict=${this.liveForceLocalFastStrict}, fastTimeout=${this.liveFastLlmTimeoutMs}ms, slowTimeout=${this.liveSlowLlmTimeoutMs}ms`);
        console.log(`[Init] Fast-path config: skipMemory=${this.fastPathSkipMemory}, skipAgent=${this.fastPathSkipAgentCore}, skipBrainnn=${this.fastPathSkipBrainnn}, skipOptional=${this.fastPathSkipOptional}, simpleThreshold=${this.fastPathSimpleComplexityThreshold}`);
        console.log(`[Init] Tool execution: mode=${this.toolExecutionMode}, enabled=${this.toolCallingEnabled}, manager=${this.managerEndpoint}`);
        console.log(`[Init] ???????????? gate: enabled=${this.memoryWriteGateEnabled}, stableMin=${this.memoryStableWriteMinConfidence}, volatileMin=${this.memoryVolatileWriteMinConfidence}`);
        console.log(`[Init] Anime trait runtime: enabled=${this.animeTraitRuntime.enabled}, profile=${this.animeTraitRuntime.profile}, variation=${this.animeTraitRuntime.variation.toFixed(2)}, noveltyBase=${this.animeTraitRuntime.noveltyBase.toFixed(2)}`);
    }

    private isNeuralPolicyMode(): boolean {
        return this.dialoguePolicyMode === 'neural';
    }

    private getLocalizedErrorPhrase(userText: string): string {
        if (TA.shouldReplyInChinese(userText, this.preferChineseByDefault)) {
            return process.env.CHAT_ERROR_MESSAGE_ZH || this.errorPhrase;
        }
        return process.env.CHAT_ERROR_MESSAGE_EN || 'AI service temporarily unavailable.';
    }

    private buildRescueReply(userText: string): string {
        const text = (userText || '').trim();
        if (!text) {
            return this.getLocalizedErrorPhrase(userText);
        }

        if (TA.shouldReplyInChinese(text, this.preferChineseByDefault)) {
            if (/2\s*\+\s*2|二加二/.test(text)) {
                return '2+2等于4。';
            }
            if (/早安|早上好/.test(text)) {
                return '早安，今天也要顺顺利利。';
            }
            if (/你好|嗨|在吗/.test(text)) {
                return '你好呀，我在呢。';
            }
            return '我在，这条我刚才没处理好。你可以再说一次关键点吗？';
        }

        if (/2\s*\+\s*2/.test(text)) {
            return '2+2 is 4.';
        }
        if (/(good morning|morning|hello|hi)/i.test(text)) {
            return 'Hello! I am here.';
        }

        return 'I am here. I did not process that well, please restate the key point.';
    }

    private buildFallbackReply(userContent: string, toolContext: string | null): string {
        return this.errorPhrase;
    }

    private getSessionKey(input: RawStreamInput): string {
        if (input.verifiedCreator) {
            return this.creatorUserId || 'creator';
        }
        const key = (input.userId || input.userName || 'anonymous').toString().trim();
        return key || 'anonymous';
    }

    private isCreatorIdentity(raw: string): boolean {
        const value = (raw || '').toString().trim().toLowerCase();
        if (!value) return false;
        if (this.creatorAliases.has(value)) return true;
        return false;
    }

    private getOrCreateSession(input: RawStreamInput): SessionState {
        const key = this.getSessionKey(input);
        const current = this.sessionState.get(key);
        if (current) {
            return current;
        }
        const creatorSession = input.verifiedCreator === true;
        const canon = this.canonicalMemory.getUser(key);
        const now = Date.now();
        const preferredName = creatorSession
            ? this.creatorDisplayName
            : this.sanitizePreferredNameCandidate(canon?.preferredName || '', false) || undefined;
        const created: SessionState = {
            key,
            phase: 'opening',
            viewerTier: 'new',
            turnCount: 0,
            reconnectCount: 0,
            lastResumeTurn: 0,
            lastUserAt: now,
            lastAssistantAt: now,
            lastNudgeTurn: 0,
            preferredName,
            isVerified: creatorSession,
            knownFacts: canon?.facts?.slice(-this.maxSessionFacts) || [],
            goals: [],
            lastUserMessages: [],
            lastReplies: [],
            lastSummaryTurn: 0,
            currentTopic: undefined,
            currentTopicLabel: undefined,
            topicTurnCount: 0,
            topicFatigue: 0,
            exhaustedTopics: [],
            updatedAt: now
        };
        if (creatorSession) {
            created.viewerTier = 'core';
            created.preferredName = this.creatorDisplayName;
        }
        this.sessionState.set(key, created);
        return created;
    }

    private syncSessionWithCanonical(session: SessionState): void {
        const canon = this.canonicalMemory.getUser(session.key);
        if (!canon) return;
        const creatorSession = this.isCreatorIdentity(session.key);
        if (!session.preferredName && canon.preferredName) {
            const normalized = this.sanitizePreferredNameCandidate(canon.preferredName, creatorSession);
            if (normalized) {
                session.preferredName = normalized;
            }
        }
        if (!creatorSession && session.preferredName && !this.isSafePublicAddressName(session.preferredName)) {
            session.preferredName = undefined;
        }
        if (canon.facts.length > 0) {
            for (const fact of canon.facts.slice(-3)) {
                TA.pushUniqueLimited(session.knownFacts, fact, this.maxSessionFacts);
            }
        }
        this.syncCanonicalToRetriever(session.key);
    }

    private syncCanonicalToRetriever(userId: string): void {
        const canon = this.canonicalMemory.getUser(userId);
        if (!canon) return;
        const facts: string[] = [];
        if (canon.preferredName) {
            facts.push(`用户名字: ${canon.preferredName}`);
        }
        for (const fact of canon.facts.slice(0, 5)) {
            facts.push(fact);
        }
        for (const pref of canon.preferences.slice(0, 3)) {
            const sentiment = pref.sentiment === 'like' || pref.sentiment === 'prefer' ? '喜欢' : '不喜欢';
            facts.push(`${sentiment}: ${pref.topic}`);
        }
        this.memoryRetriever.setCanonicalMemory(userId, facts);
    }

    private isSafePublicAddressName(raw: string): boolean {
        const name = TA.normalizeAddressName(raw);
        if (!name) return false;
        if (name.length < 2 || name.length > this.publicSafeNameMaxLen) return false;
        if (/^(viewer|anonymous|unknown|danmaku|guest|user|uid|id|游客|观众|路人)$/i.test(name)) return false;
        if (/^(uid|user|id|room|live)[\-_]?\d+$/i.test(name)) return false;
        if (/^\d{3,}$/.test(name)) return false;
        if (/(.)\1{4,}/.test(name)) return false;
        const digitCount = (name.match(/\d/g) || []).length;
        if (name.length > 0 && (digitCount / name.length) > this.publicSafeNameMaxDigitRatio) return false;
        const letterOrCjkCount = (name.match(/[A-Za-z\u4e00-\u9fff]/g) || []).length;
        if (letterOrCjkCount <= 0) return false;
        return true;
    }

    private sanitizePreferredNameCandidate(raw: string, creatorSession: boolean): string {
        const normalized = TA.normalizeAddressName(raw);
        if (!normalized) return '';
        if (creatorSession) return normalized;
        return this.isSafePublicAddressName(normalized) ? normalized : '';
    }

    private getAddressableName(session: SessionState, input: RawStreamInput): string | null {
        if (TA.isCreatorSession(input)) {
            return this.creatorDisplayName;
        }
        if (input.source === 'danmaku') {
            const fromSession = this.sanitizePreferredNameCandidate(session.preferredName || '', false);
            if (fromSession) return fromSession;
            const fromCanonical = this.sanitizePreferredNameCandidate(this.canonicalMemory.getUser(session.key)?.preferredName || '', false);
            if (fromCanonical) return fromCanonical;
            return null;
        }
        const fromSession = this.sanitizePreferredNameCandidate(session.preferredName || '', false);
        if (fromSession) return fromSession;
        const fromCanonical = this.sanitizePreferredNameCandidate(this.canonicalMemory.getUser(session.key)?.preferredName || '', false);
        if (fromCanonical) return fromCanonical;
        const fromLiveInput = [input.userName, input.userId]
            .map((value) => this.sanitizePreferredNameCandidate(String(value || ''), false))
            .find(Boolean);
        if (fromLiveInput) return fromLiveInput;
        return null;
    }

    private getPublicAddressFallback(chinesePreferred: boolean): string {
        return chinesePreferred ? this.publicAddressFallbackZh : this.publicAddressFallbackEn;
    }

    private sanitizeUnsafePublicIdsInReply(text: string, input: RawStreamInput, safeName: string | null): { text: string; changed: boolean } {
        if (TA.isCreatorSession(input)) {
            return { text, changed: false };
        }
        const candidates = [input.userId, input.userName]
            .map((value) => TA.normalizeAddressName(String(value || '')))
            .filter(Boolean);
        const explicitNamePatterns: RegExp[] = [
            /(?:我叫|我是|叫我|你可以叫我|请叫我)\s*([A-Za-z0-9_\-\u4e00-\u9fff]{1,24})/,
            /(?:my name is|call me)\s+([A-Za-z0-9_\-]{1,24})/i
        ];
        const source = (input.content || '').trim();
        for (const pattern of explicitNamePatterns) {
            const match = source.match(pattern);
            if (!match?.[1]) continue;
            const normalized = TA.normalizeAddressName(match[1]);
            if (!normalized) continue;
            candidates.push(normalized);
        }
        const uniqueCandidates = Array.from(new Set(candidates));
        if (uniqueCandidates.length === 0) {
            return { text, changed: false };
        }
        const fallback = this.getPublicAddressFallback(TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault));
        let output = text;
        let changed = false;
        const genericMasked = output
            .replace(/\b(?:uid|user|id|room|live)[\-_]?\d+\b/gi, fallback)
            .replace(/\b\d{4,}\b/g, fallback);
        if (genericMasked !== output) {
            output = genericMasked;
            changed = true;
        }
        for (const candidate of uniqueCandidates) {
            if (safeName && candidate.toLowerCase() === safeName.toLowerCase()) continue;
            if (this.isSafePublicAddressName(candidate)) continue;
            const pattern = new RegExp(TA.escapeRegExp(candidate), 'g');
            const replaced = output.replace(pattern, fallback);
            if (replaced !== output) {
                output = replaced;
                changed = true;
            }
        }
        return { text: output, changed };
    }

    private extractPreferenceUpdates(source: string, creatorSession: boolean): SessionUpdate['preferences'] {
        const updates: SessionUpdate['preferences'] = [];
        const explicitStable = /(记住|长期|固定|永远|always|long[-\s]?term|persistent)/i.test(source);
        const patterns: Array<{ regex: RegExp; sentiment: PreferenceSentiment; confidence: number }> = [
            { regex: /(?:我喜欢|我爱|我偏好|我更喜欢)\s*([^，。！？,.!?]{1,24})/i, sentiment: 'like', confidence: 0.74 },
            { regex: /(?:我不喜欢|我讨厌|我不爱|我避免)\s*([^，。！？,.!?]{1,24})/i, sentiment: 'dislike', confidence: 0.74 },
            { regex: /(?:i like|i love|i prefer)\s+([a-z0-9 _\-]{1,24})/i, sentiment: 'prefer', confidence: 0.72 },
            { regex: /(?:i don't like|i dislike|i hate|i avoid)\s+([a-z0-9 _\-]{1,24})/i, sentiment: 'avoid', confidence: 0.72 },
            { regex: /(?:我最近在|我正在|最近迷上)\s*([^，。！？,.!?]{1,24})/i, sentiment: 'like', confidence: 0.65 },
            { regex: /(?:最近在玩|最近在看|最近在听)\s*([^，。！？,.!?]{1,24})/i, sentiment: 'like', confidence: 0.68 },
            { regex: /(?:im into|i'm into|i've been into)\s+([a-z0-9 _\-]{1,24})/i, sentiment: 'prefer', confidence: 0.65 },
            { regex: /(?:playing|watching|listening to)\s+([a-z0-9 _\-]{1,24})\s+(lately|recently)/i, sentiment: 'prefer', confidence: 0.62 },
            { regex: /(?:最讨厌|最不喜欢|受不了)\s*([^，。！？,.!?]{1,24})/i, sentiment: 'dislike', confidence: 0.78 },
            { regex: /(?:hate|can't stand|worst)\s+([a-z0-9 _\-]{1,24})/i, sentiment: 'avoid', confidence: 0.75 }
        ];

        for (const item of patterns) {
            const match = source.match(item.regex);
            if (!match?.[1]) continue;
            const topic = TA.normalizePreferenceTopic(match[1]);
            if (!topic) continue;
            const exists = updates.some((pref) =>
                pref.topic.toLowerCase() === topic.toLowerCase() && pref.sentiment === item.sentiment
            );
            if (exists) continue;
            updates.push({
                topic,
                sentiment: item.sentiment,
                confidence: TA.clampMemoryConfidence(item.confidence + (creatorSession ? 0.03 : 0)),
                volatile: !explicitStable,
                sourceText: source.slice(0, 120)
            });
        }

        return updates;
    }

    private extractTaskUpdates(source: string, creatorSession: boolean): SessionUpdate['tasks'] {
        const updates: SessionUpdate['tasks'] = [];
        if (!creatorSession) return updates;

        const pushTask = (text: string, status: 'open' | 'done', confidence: number): void => {
            const normalized = (text || '').trim().replace(/\s+/g, ' ').slice(0, 120);
            if (!normalized) return;
            if (/[?？]$/.test(normalized) && status === 'done') return;
            const exists = updates.some(
                (task) => task.text.toLowerCase() === normalized.toLowerCase() && task.status === status
            );
            if (exists) return;
            updates.push({
                text: normalized,
                status,
                confidence: TA.clampMemoryConfidence(confidence),
                source: 'creator'
            });
        };

        const explicitOpen = source.match(/(?:待办|todo|任务|task|计划|plan|下一步)\s*[:：]?\s*(.+)$/i);
        if (explicitOpen?.[1]) {
            pushTask(explicitOpen[1], 'open', 0.9);
        }

        const explicitDone = source.match(/(?:完成|搞定|done|finished)\s*[:：]?\s*(.+)$/i);
        if (explicitDone?.[1]) {
            pushTask(explicitDone[1], 'done', 0.9);
        }

        const imperative = source.match(/(?:请你|帮我|麻烦你|需要你)\s*(.+)$/i);
        if (imperative?.[1] && !/[?？]/.test(source)) {
            pushTask(imperative[1], 'open', 0.72);
        }

        // "xxx 搞定了", "xxx 完成了"
        const trailingDone = source.match(/^(.+?)\s*(?:搞定了|完成了|弄好了|不弄了)$/);
        if (trailingDone?.[1]) {
            pushTask(trailingDone[1], 'done', 0.85);
        }

        return updates;
    }

    private scoreMemoryWriteConfidence(
        input: RawStreamInput,
        kind: 'name' | 'fact' | 'preference' | 'task' | 'goal',
        text: string,
        base: number
    ): number {
        let score = base;
        const sourceText = (input.content || '').trim();
        const textLower = (text || '').toLowerCase();
        
        if (TA.isCreatorSession(input)) {
            score += this.creatorMemoryTrustBoost;
        }
        if (TA.hasUncertainCue(sourceText)) {
            score -= 0.2;
        }
        if ((kind === 'name' || kind === 'fact' || kind === 'preference') && /[?？]/.test(sourceText)) {
            score -= 0.16;
        }
        if ((text || '').length > 90) {
            score -= 0.06;
        }
        if ((text || '').length < 2) {
            score -= 0.2;
        }
        
        const garbagePatterns = [
            /^(test|测试|hello|hi|你好|哈哈|呵呵|ok|okay|对不对|可不可以|可以|不可以)$/i,
            /^[.。?？!！:：\s]+$/,
            /^(.)\1{3,}$/,
            /^(test_\d+|user\d*|anonymous|guest\d*)$/i
        ];
        for (const pattern of garbagePatterns) {
            if (pattern.test(textLower)) {
                score -= 0.4;
                break;
            }
        }
        
        const lowInfoPatterns = [
            /^(不知道|不清楚|没想好|随便|都行|都可以|无所谓)$/i,
            /^(i don'?t know|not sure|whatever|anything)$/i
        ];
        for (const pattern of lowInfoPatterns) {
            if (pattern.test(textLower)) {
                score -= 0.25;
                break;
            }
        }
        
        return TA.clampMemoryConfidence(score);
    }

    private shouldAllowStableMemoryWrite(confidence: number): boolean {
        if (!this.memoryWriteGateEnabled) return confidence >= 0.2;
        return confidence >= this.memoryStableWriteMinConfidence;
    }

    private shouldAllowVolatileMemoryWrite(confidence: number): boolean {
        if (!this.memoryWriteGateEnabled) return confidence >= 0.2;
        return confidence >= this.memoryVolatileWriteMinConfidence;
    }

    private shouldReplaceConflict(existingConfidence: number, incomingConfidence: number, creatorSession: boolean): boolean {
        if (creatorSession) return true;
        return incomingConfidence >= existingConfidence + this.memoryConflictOverwriteMargin;
    }

    private pushPreferenceFact(session: SessionState, pref: { topic: string; sentiment: PreferenceSentiment }): void {
        const zhSentiment = pref.sentiment === 'dislike' || pref.sentiment === 'avoid' ? '不喜欢' : '偏好';
        TA.pushUniqueLimited(session.knownFacts, `${zhSentiment}:${pref.topic}`, this.maxSessionFacts);
    }

    private extractSessionUpdate(input: RawStreamInput): SessionUpdate {
        const source = (input.content || '').trim();
        const creatorSession = TA.isCreatorSession(input);
        const update: SessionUpdate = { facts: [], preferences: [], tasks: [] };
        if (!source) return update;

        const looksLikeQuestion = /[?？]/.test(source);
        const namePatterns: RegExp[] = [
            /(?:我叫|我是|叫我|你可以叫我|请叫我)\s*([A-Za-z0-9_\-\u4e00-\u9fff]{1,24})/,
            /(?:my name is|call me)\s+([A-Za-z][A-Za-z0-9_\- ]{0,23})/i,
            /(?:wo jiao|wo shi|jiao wo)\s+([a-z][a-z0-9_\- ]{0,23})/i
        ];
        if (!looksLikeQuestion) {
            for (const pattern of namePatterns) {
                const match = source.match(pattern);
                if (match && match[1]) {
                    const normalized = this.sanitizePreferredNameCandidate(match[1], creatorSession);
                    if (normalized) {
                        update.preferredName = normalized;
                        break;
                    }
                }
            }
        }

        const rememberMatch = source.match(/(?:记住|记一下|记得|remember this|note that)\s*[:：]?\s*(.+)$/i);
        if (rememberMatch?.[1]) {
            const fact = rememberMatch[1].trim();
            if (fact) {
                update.facts.push(fact.slice(0, 80));
            }
        }

        update.preferences = this.extractPreferenceUpdates(source, creatorSession);
        update.tasks = this.extractTaskUpdates(source, creatorSession);

        const isGoal = /[?？]/.test(source) || /(帮我|请你|麻烦|如何|怎么|why|how|can you|could you|help me)/i.test(source);
        if (isGoal) {
            update.goal = source.slice(0, 80);
        }

        return update;
    }

    private applySessionUpdate(session: SessionState, update: SessionUpdate, input: RawStreamInput): void {
        const creatorSession = TA.isCreatorSession(input);
        const canon = this.canonicalMemory.getUser(session.key);
        const now = Date.now();
        const stableFacts: string[] = [];
        const stablePreferences: Array<Omit<CanonicalPreference, 'updatedAt'> & { updatedAt?: number }> = [];
        const stableTasks: Array<Omit<CanonicalTask, 'updatedAt'> & { updatedAt?: number }> = [];

        const noteWriteDecision = (confidence: number, stableAccepted: boolean, volatileAccepted: boolean): void => {
            this.metrics.memoryWriteStats.evaluated += 1;
            if (stableAccepted) {
                this.metrics.memoryWriteStats.stableAccepted += 1;
                return;
            }
            if (volatileAccepted) {
                this.metrics.memoryWriteStats.volatileAccepted += 1;
                return;
            }
            this.metrics.memoryWriteStats.rejected += 1;
        };

        const preferredNameCandidate = update.preferredName
            ? this.sanitizePreferredNameCandidate(update.preferredName, creatorSession)
            : '';
        if (update.preferredName && !preferredNameCandidate) {
            noteWriteDecision(0, false, false);
            console.log(`[MemoryWriteGate] unsafe_name_rejected user=${session.key} name=${update.preferredName}`);
        }
        if (preferredNameCandidate) {
            const confidence = this.scoreMemoryWriteConfidence(input, 'name', preferredNameCandidate, 0.95);
            const stableAccepted = this.shouldAllowStableMemoryWrite(confidence);
            noteWriteDecision(confidence, stableAccepted, false);
            if (stableAccepted) {
                const existingName = canon?.preferredName || session.preferredName;
                if (existingName && existingName !== preferredNameCandidate) {
                    this.metrics.memoryWriteStats.conflictsDetected += 1;
                    const isExplicitRename = /(改名|以后叫|rename|call me now|now call me|change.*name|new name)/i.test(input.content || '');
                    const isSameSession = session.turnCount <= 3;
                    
                    if (creatorSession || isExplicitRename) {
                        session.preferredName = preferredNameCandidate;
                        this.canonicalMemory.setPreferredName(session.key, preferredNameCandidate);
                        this.syncCanonicalToRetriever(session.key);
                        this.canonicalMemory.addConflict(session.key, {
                            kind: 'name',
                            previous: existingName,
                            incoming: preferredNameCandidate,
                            detail: 'name_change_accepted',
                            resolved: true
                        });
                        console.log(`[MemoryWriteGate] name_change_accepted user=${session.key} from=${existingName} to=${preferredNameCandidate}`);
                    } else if (isSameSession) {
                        session.preferredName = preferredNameCandidate;
                        this.canonicalMemory.setPreferredName(session.key, preferredNameCandidate);
                        this.syncCanonicalToRetriever(session.key);
                        console.log(`[MemoryWriteGate] name_updated_early_session user=${session.key} to=${preferredNameCandidate}`);
                    } else {
                        this.canonicalMemory.addConflict(session.key, {
                            kind: 'name',
                            previous: existingName,
                            incoming: preferredNameCandidate,
                            detail: 'name_conflict_pending',
                            resolved: false
                        });
                        console.log(`[MemoryWriteGate] name_conflict_pending user=${session.key} existing=${existingName} incoming=${preferredNameCandidate}`);
                    }
                } else {
                    session.preferredName = preferredNameCandidate;
                    this.canonicalMemory.setPreferredName(session.key, preferredNameCandidate);
                    this.syncCanonicalToRetriever(session.key);
                }
            }
        }

        for (const fact of update.facts) {
            const confidence = this.scoreMemoryWriteConfidence(input, 'fact', fact, 0.88);
            const stableAccepted = this.shouldAllowStableMemoryWrite(confidence);
            const volatileAccepted = !stableAccepted && this.shouldAllowVolatileMemoryWrite(confidence);
            noteWriteDecision(confidence, stableAccepted, volatileAccepted);
            const preferenceLikeFact = /(偏好|喜欢|不喜欢|讨厌|avoid|prefer|i like|i don't like|dislike)/i.test(fact);
            if (preferenceLikeFact) {
                if (stableAccepted || volatileAccepted) {
                    TA.pushUniqueLimited(session.knownFacts, fact, this.maxSessionFacts);
                }
                continue;
            }
            if (stableAccepted) {
                const conflict = TA.detectFactConflict(canon?.facts || [], fact);
                if (conflict) {
                    this.metrics.memoryWriteStats.conflictsDetected += 1;
                    this.canonicalMemory.addConflict(session.key, {
                        kind: 'fact',
                        previous: conflict,
                        incoming: fact,
                        detail: 'fact_negation_conflict',
                        resolved: creatorSession
                    });
                    if (!creatorSession) {
                        continue;
                    }
                }
                stableFacts.push(fact);
                TA.pushUniqueLimited(session.knownFacts, fact, this.maxSessionFacts);
            } else if (volatileAccepted) {
                TA.pushUniqueLimited(session.knownFacts, fact, this.maxSessionFacts);
            }
        }

        for (const pref of update.preferences) {
            const confidence = this.scoreMemoryWriteConfidence(input, 'preference', pref.topic, pref.confidence);
            const allowStable = !pref.volatile && this.shouldAllowStableMemoryWrite(confidence);
            const allowVolatile = !allowStable && this.shouldAllowVolatileMemoryWrite(confidence);
            noteWriteDecision(confidence, allowStable, allowVolatile);
            if (!allowStable && !allowVolatile) continue;

            const conflict = TA.findPreferenceConflict(canon?.preferences || [], pref);
            if (conflict) {
                this.metrics.memoryWriteStats.conflictsDetected += 1;
                this.canonicalMemory.addConflict(session.key, {
                    kind: 'preference',
                    previous: `${conflict.sentiment}:${conflict.topic}`,
                    incoming: `${pref.sentiment}:${pref.topic}`,
                    detail: 'preference_polarity_conflict',
                    resolved: this.shouldReplaceConflict(conflict.confidence, confidence, creatorSession)
                });
                if (!this.shouldReplaceConflict(conflict.confidence, confidence, creatorSession)) {
                    continue;
                }
            }

            if (allowStable) {
                stablePreferences.push({
                    topic: pref.topic,
                    sentiment: pref.sentiment,
                    confidence,
                    volatile: false,
                    sourceText: pref.sourceText,
                    updatedAt: now
                });
            } else if (allowVolatile) {
                stablePreferences.push({
                    topic: pref.topic,
                    sentiment: pref.sentiment,
                    confidence,
                    volatile: true,
                    sourceText: pref.sourceText,
                    updatedAt: now
                });
            }
            this.pushPreferenceFact(session, pref);
        }

        for (const task of update.tasks) {
            const confidence = this.scoreMemoryWriteConfidence(input, 'task', task.text, task.confidence);
            const stableAccepted = this.shouldAllowStableMemoryWrite(confidence);
            const volatileAccepted = !stableAccepted && this.shouldAllowVolatileMemoryWrite(confidence);
            noteWriteDecision(confidence, stableAccepted, volatileAccepted);

            if (stableAccepted || volatileAccepted) {
                // 如果是标记完成，且没有完全匹配，尝试模糊匹配当前 Open 任务
                let finalTaskText = task.text;
                if (task.status === 'done' && canon?.tasks?.length) {
                    const openTasks = canon.tasks.filter(t => t.status === 'open');
                    const match = openTasks.find(t =>
                        t.text.toLowerCase().includes(task.text.toLowerCase()) ||
                        task.text.toLowerCase().includes(t.text.toLowerCase())
                    );
                    if (match) {
                        finalTaskText = match.text;
                    }
                }

                stableTasks.push({
                    text: finalTaskText,
                    status: task.status,
                    confidence,
                    source: task.source,
                    updatedAt: now
                });
            }
        }

        if (stableFacts.length > 0) {
            this.canonicalMemory.addFacts(session.key, stableFacts);
        }
        if (stablePreferences.length > 0) {
            this.canonicalMemory.addPreferences(session.key, stablePreferences);
        }
        if (stableTasks.length > 0) {
            this.canonicalMemory.upsertTasks(session.key, stableTasks);
        }
        if (creatorSession && (stableFacts.length > 0 || stablePreferences.length > 0 || stableTasks.length > 0 || !!preferredNameCandidate)) {
            this.metrics.memoryWriteStats.creatorProfileWrites += 1;
        }

        if (update.goal) {
            const goalConfidence = this.scoreMemoryWriteConfidence(input, 'goal', update.goal, creatorSession ? 0.7 : 0.58);
            const keepGoal = this.shouldAllowVolatileMemoryWrite(goalConfidence);
            noteWriteDecision(goalConfidence, false, keepGoal);
            if (keepGoal) {
                const duplicate = session.goals.find((goal) => goal.text === update.goal && goal.status === 'open');
                if (!duplicate) {
                    session.goals.push({
                        text: update.goal,
                        status: 'open',
                        createdAt: now,
                        updatedAt: now
                    });
                    this.metrics.goalStats.opened += 1;
                    const openGoals = session.goals.filter((goal) => goal.status === 'open');
                    if (openGoals.length > this.maxSessionGoals) {
                        const oldestOpen = openGoals.sort((a, b) => a.createdAt - b.createdAt)[0];
                        oldestOpen.status = 'done';
                        oldestOpen.updatedAt = now;
                    }
                }
            }
        }

        session.updatedAt = Date.now();
    }

    private detectSessionResume(session: SessionState): boolean {
        const now = Date.now();
        const last = Math.max(session.lastUserAt || 0, session.lastAssistantAt || 0);
        if (!last) return false;
        if (now - last < this.sessionResumeGapMs) return false;
        session.reconnectCount += 1;
        session.lastResumeTurn = session.turnCount;
        session.phase = 'opening';
        return true;
    }

    /**
     * Track topic fatigue to avoid repetitive loops.
     * Uses two signals:
     * 1) user input overlaps with current topic keywords
     * 2) reply is too similar to recent replies
     */
    private suggestTopicShift(session: SessionState): string | null {
        if (session.topicFatigue < this.topicFatigueSuggestThreshold) return null;

        const controlManager = getControlManager();
        const state = controlManager.getState();
        if (state.currentTopic) return null;

        const suggestion = controlManager.suggestTopic();
        if (suggestion) {
            return `${suggestion.topic}${suggestion.context ? ` (${suggestion.context})` : ''}`;
        }

        return '聊聊最近的心情，或者分享一个小秘密';
    }

    private inferViewerTier(session: SessionState, memoryContext?: MemoryContext | null): ViewerTier {
        const canon = this.canonicalMemory.getUser(session.key);
        const interactions = Math.max(
            canon?.interactionCount || 0,
            memoryContext?.userProfile?.totalInteractions || 0
        );
        const tags = [
            ...(memoryContext?.userProfile?.tags || []),
            ...(canon?.facts || [])
        ].join('|').toLowerCase();

        if (interactions >= 24) {
            return 'core';
        }
        if (interactions >= 12 && /(铁粉|核心|core|vip|大佬)/.test(tags)) {
            return 'core';
        }
        if (interactions >= 6) {
            return 'regular';
        }
        if (interactions >= 3 && /(铁粉|常客|regular)/.test(tags)) {
            return 'regular';
        }
        return 'new';
    }

    private shouldInjectGoalNudge(session: SessionState): boolean {
        if (this.isNeuralPolicyMode() && this.neuralModeSkipGoalDriver) return false;
        if (session.phase === 'closing') return false;
        if (session.turnCount < 2) return false;
        const delta = session.turnCount - session.lastNudgeTurn;
        const hasOpenGoal = session.goals.some((goal) => goal.status === 'open');
        if (hasOpenGoal && delta >= this.goalNudgeMinTurns) return true;
        return delta >= this.goalNudgeMaxTurns;
    }

    private applyGoalDriver(reply: string, input: RawStreamInput, session: SessionState): { text: string; nudged: boolean } {
        if (TA.isCreatorSession(input)) {
            return { text: (reply || '').trim(), nudged: false };
        }
        if (!this.shouldInjectGoalNudge(session)) {
            return { text: reply, nudged: false };
        }

        const chinese = TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault);
        const base = (reply || '').trim();
        if (!base) return { text: reply, nudged: false };
        if (
            TA.isSelfIdentityQuery(input.content || '') ||
            TA.isNameRecallQuery(input.content || '') ||
            TA.isUserIdentityQuery(input.content || '')
        ) {
            return { text: base, nudged: false };
        }
        if (/temporarily unavailable|掉线|无法|稍后再试/i.test(base)) {
            return { text: base, nudged: false };
        }
        if (/[?？]$/.test(base) || /(要不要|可以吗|行吗|would you|do you want)/i.test(base)) {
            session.lastNudgeTurn = session.turnCount;
            this.metrics.goalStats.nudges += 1;
            return { text: base, nudged: true };
        }

        const nudge = TA.buildGoalNudge(session, chinese);
        const joined = `${base}${chinese ? ' ' : ' '}${nudge}`.trim();
        session.lastNudgeTurn = session.turnCount;
        this.metrics.goalStats.nudges += 1;
        return { text: joined, nudged: true };
    }

    private formatRuntimeStateSummary(evidence: RuntimeStateEvidence, targets: string[]): string {
        const list = targets.length > 0 ? targets : Object.keys(evidence.serviceStates);
        if (list.length === 0) {
            return evidence.available
                ? 'runtime_state=evidence_available_no_targets'
                : 'runtime_state=evidence_unavailable';
        }
        const rows = list.map((id) => `${id}=${evidence.serviceStates[id] || 'unknown'}`);
        return rows.join(', ');
    }

    private async fetchRuntimeStateEvidence(userText: string): Promise<RuntimeStateEvidence> {
        const fetchedAt = Date.now();
        const targets = TA.extractRuntimeStateTargets(userText);
        const managerBase = (this.managerEndpoint || '').replace(/\/+$/, '');
        const states: Record<string, 'running' | 'stopped' | 'unknown'> = {};
        const notes: string[] = [];

        try {
            const servicesResp = await axios.get(`${managerBase}/api/services`, {
                timeout: this.runtimeStateTimeoutMs
            });
            const listRaw = servicesResp?.data;
            const list = Array.isArray(listRaw)
                ? listRaw
                : (Array.isArray(listRaw?.value) ? listRaw.value : []);
            for (const item of list) {
                const id = String(item?.id || '').trim();
                if (!id) continue;
                const status = String(item?.status || '').toLowerCase();
                states[id] = status === 'running'
                    ? 'running'
                    : (status === 'stopped' ? 'stopped' : 'unknown');
            }

            try {
                const sovitsResp = await axios.get(`${managerBase}/api/sovits/status`, {
                    timeout: Math.min(this.runtimeStateTimeoutMs, 1800)
                });
                const ready = sovitsResp?.data?.ready;
                if (typeof ready === 'boolean') {
                    states['sovits-api'] = ready ? 'running' : 'stopped';
                }
            } catch (error: any) {
                notes.push(`sovits_probe_failed:${error?.message || error}`);
            }

            try {
                const visionStatus = this.visionService.getStatus();
                const visionReady = visionStatus.enabled && visionStatus.modelLoaded;
                states['vision'] = visionReady ? 'running' : 'stopped';
                if (!visionStatus.enabled) {
                    notes.push('vision_disabled');
                } else if (!visionStatus.modelLoaded) {
                    notes.push('vision_model_unavailable');
                }
            } catch (error: any) {
                notes.push(`vision_status_failed:${error?.message || error}`);
            }

            const summary = this.formatRuntimeStateSummary(
                { available: true, source: 'manager', fetchedAt, serviceStates: states, summary: '', notes },
                targets
            );
            this.metrics.groundingStats.evidenceFetched += 1;
            return {
                available: Object.keys(states).length > 0,
                source: 'manager',
                fetchedAt,
                serviceStates: states,
                summary,
                notes
            };
        } catch (error: any) {
            notes.push(`manager_fetch_failed:${error?.message || error}`);
        }

        const localTargets: Array<{ id: string; url: string }> = [
            { id: 'memory-universe', url: 'http://127.0.0.1:4005/health' },
            { id: 'memory-tts', url: 'http://127.0.0.1:4014/health' },
            { id: 'live2d', url: 'http://127.0.0.1:4002/health' }
        ];
        for (const local of localTargets) {
            try {
                const resp = await axios.get(local.url, { timeout: Math.min(this.runtimeStateTimeoutMs, 1200) });
                states[local.id] = resp?.status >= 200 && resp?.status < 300 ? 'running' : 'unknown';
            } catch {
                states[local.id] = 'stopped';
            }
        }

        try {
            const visionStatus = this.visionService.getStatus();
            const visionReady = visionStatus.enabled && visionStatus.modelLoaded;
            states['vision'] = visionReady ? 'running' : 'stopped';
            if (!visionStatus.enabled) {
                notes.push('vision_disabled');
            } else if (!visionStatus.modelLoaded) {
                notes.push('vision_model_unavailable');
            }
        } catch (error: any) {
            notes.push(`vision_status_failed:${error?.message || error}`);
        }

        const hasLocalEvidence = Object.keys(states).length > 0;
        if (hasLocalEvidence) {
            this.metrics.groundingStats.evidenceFetched += 1;
            return {
                available: true,
                source: 'local',
                fetchedAt,
                serviceStates: states,
                summary: this.formatRuntimeStateSummary(
                    { available: true, source: 'local', fetchedAt, serviceStates: states, summary: '', notes },
                    targets
                ),
                notes
            };
        }

        this.metrics.groundingStats.evidenceMissing += 1;
        return {
            available: false,
            source: 'none',
            fetchedAt,
            serviceStates: {},
            summary: 'runtime_state=evidence_unavailable',
            notes
        };
    }

    private enforceCapabilityScopeAnswer(
        reply: string,
        input: RawStreamInput,
        evidence: RuntimeStateEvidence | null
    ): string {
        const isCapabilityQuery = TA.isCapabilityScopeQuery(input.content || '');
        const isVisualQuery = TA.isVisualCapabilityQuery(input.content || '');
        if (!isCapabilityQuery && !isVisualQuery) return (reply || '').trim();
        this.metrics.capabilityScopeStats.queries += 1;
        const text = (reply || '').trim();
        if (!TA.isMeaningfulText(text)) {
            this.metrics.capabilityScopeStats.fallbackApplied += 1;
            return this.buildCapabilityScopeFallbackReply(input, evidence);
        }
        if (TA.hasCapabilityOverclaim(text)) {
            this.metrics.capabilityScopeStats.overclaimDetected += 1;
            this.metrics.capabilityScopeStats.fallbackApplied += 1;
            return this.buildCapabilityScopeFallbackReply(input, evidence);
        }
        if (isCapabilityQuery && !TA.hasCapabilityDualStatement(text)) {
            this.metrics.capabilityScopeStats.fallbackApplied += 1;
            return this.buildCapabilityScopeFallbackReply(input, evidence);
        }
        if (isVisualQuery) {
            const visionReady = evidence?.serviceStates?.vision === 'running';
            if (!visionReady && TA.hasVisualObservationClaim(text) && !TA.hasUncertaintyMarker(text)) {
                this.metrics.capabilityScopeStats.overclaimDetected += 1;
                this.metrics.capabilityScopeStats.fallbackApplied += 1;
                return this.buildCapabilityScopeFallbackReply(input, evidence);
            }
        }
        return text;
    }

    private detectStateGroundingIssue(
        reply: string,
        input: RawStreamInput,
        strategy: DialogueStrategy,
        evidence: RuntimeStateEvidence | null
    ): string | null {
        if (!strategy.requiresStateGrounding) return null;
        const text = (reply || '').trim();
        if (!text) return 'state_empty_reply';
        if (!evidence || !evidence.available) {
            return TA.hasUncertaintyMarker(text) ? null : 'state_claim_without_evidence';
        }

        if (TA.isCapabilityScopeQuery(input.content || '')) {
            const hasStoppedService = Object.values(evidence.serviceStates).some((state) => state === 'stopped');
            if (hasStoppedService && TA.hasCapabilityOverclaim(text) && !TA.hasUncertaintyMarker(text)) {
                return 'capability_overclaim_with_stopped_service';
            }
            const ttsReady = evidence.serviceStates['memory-tts'] === 'running' || evidence.serviceStates['sovits-api'] === 'running';
            const ttsNegative = /(不能|无法|不支持|暂时不能|currently cannot).{0,10}(语音|播报|tts|sovits|合成)/i.test(text);
            const ttsPositive = /(能|可以|支持|available|can).{0,10}(语音|播报|tts|sovits|合成)/i.test(text);
            if (ttsReady && ttsNegative && !TA.hasUncertaintyMarker(text)) {
                return 'capability_conflict_tts_running';
            }
            if (!ttsReady && ttsPositive && !TA.hasUncertaintyMarker(text)) {
                return 'capability_conflict_tts_stopped';
            }

            const live2dReady = evidence.serviceStates['live2d'] === 'running';
            const live2dNegative = /(不能|无法|不支持|暂时不能|currently cannot).{0,12}(live2d|立绘|表情|动作)/i.test(text);
            const live2dPositive = /(能|可以|支持|available|can).{0,12}(live2d|立绘|表情|动作)/i.test(text);
            if (live2dReady && live2dNegative && !TA.hasUncertaintyMarker(text)) {
                return 'capability_conflict_live2d_running';
            }
            if (!live2dReady && live2dPositive && !TA.hasUncertaintyMarker(text)) {
                return 'capability_conflict_live2d_stopped';
            }
        }

        if (TA.isVisualCapabilityQuery(input.content || '')) {
            const visionReady = evidence.serviceStates['vision'] === 'running';
            if (!visionReady && TA.hasVisualObservationClaim(text) && !TA.hasUncertaintyMarker(text)) {
                return 'visual_claim_without_vision';
            }
        }

        const targets = TA.extractRuntimeStateTargets(input.content || '');
        if (targets.length > 0) {
            const addressed = targets.some((serviceId) => TA.replyMentionsRuntimeService(text, serviceId));
            if (!addressed && !TA.hasUncertaintyMarker(text)) {
                return 'state_query_not_addressed';
            }
        }
        const candidateTargets = targets.length > 0 ? targets : Object.keys(evidence.serviceStates);
        for (const serviceId of candidateTargets) {
            const serviceState = evidence.serviceStates[serviceId];
            if (!serviceState || serviceState === 'unknown') continue;
            const mentioned = TA.replyMentionsRuntimeService(text, serviceId);
            if (!mentioned) continue;
            if (serviceState === 'running' && TA.hasStrongRuntimeNegativeClaim(text)) {
                return `state_conflict_${serviceId}_running`;
            }
            if (serviceState === 'stopped' && TA.hasStrongRuntimePositiveClaim(text)) {
                return `state_conflict_${serviceId}_stopped`;
            }
        }
        return null;
    }

    private buildDialogueStrategy(input: RawStreamInput, session: SessionState, route: ResponseRoute): DialogueStrategy {
        const content = (input.content || '').trim();
        const intentTags: string[] = [];
        const requiredFacts: string[] = [];
        const forbiddenBehaviors: string[] = [
            'do_not_output_meta_analysis',
            'do_not_use_fixed_template_phrases'
        ];
        const styleVector: string[] = ['conversational', 'concise', 'in-character'];
        let requiresMemoryGrounding = false;
        let requiresStateGrounding = false;
        let stateGroundingMode: DialogueStrategy['stateGroundingMode'] = 'off';
        let uncertaintyMode: DialogueStrategy['uncertaintyMode'] = 'off';
        const creatorSession = TA.isCreatorSession(input);

        if (TA.isNameRecallQuery(content) || TA.isUserIdentityQuery(content)) {
            intentTags.push('identity_memory_query');
            requiresMemoryGrounding = true;
            const expectedName = this.getAddressableName(session, input);
            if (expectedName) {
                requiredFacts.push(`preferred_name=${expectedName}`);
            } else {
                requiredFacts.push('preferred_name=unknown');
            }
            forbiddenBehaviors.push('do_not_fabricate_user_identity');
        }

        if (TA.isSelfIdentityQuery(content)) {
            intentTags.push('self_identity_query');
            requiredFacts.push(`persona_name=${this.personaName}`);
        }

        if (TA.isKnowledgeSensitiveQuery(content)) {
            intentTags.push('time_sensitive_or_knowledge_sensitive');
            uncertaintyMode = route === 'slow' ? 'strict' : 'soft';
            forbiddenBehaviors.push('do_not_present_unverified_claims_as_facts');
        }

        if (TA.isRuntimeStateQuery(content)) {
            intentTags.push('runtime_state_query');
            requiresStateGrounding = true;
            stateGroundingMode = route === 'slow' ? 'strict' : 'best_effort';
            uncertaintyMode = route === 'slow' ? 'strict' : uncertaintyMode;
            forbiddenBehaviors.push('do_not_claim_runtime_state_without_evidence');
        }

        if (TA.isCapabilityScopeQuery(content)) {
            intentTags.push('capability_scope_query');
            requiresStateGrounding = true;
            stateGroundingMode = route === 'slow' ? 'strict' : 'best_effort';
            uncertaintyMode = route === 'slow' ? 'strict' : (uncertaintyMode === 'off' ? 'soft' : uncertaintyMode);
            forbiddenBehaviors.push('do_not_overclaim_current_capabilities');
            requiredFacts.push('capability_scope=runtime_services_and_tools');
        }

        if (TA.isVisualCapabilityQuery(content)) {
            intentTags.push('visual_capability_query');
            requiresStateGrounding = true;
            stateGroundingMode = route === 'slow' ? 'strict' : 'best_effort';
            uncertaintyMode = route === 'slow' ? 'strict' : (uncertaintyMode === 'off' ? 'soft' : uncertaintyMode);
            forbiddenBehaviors.push('do_not_claim_visual_observation_without_vision_evidence');
            requiredFacts.push('vision_scope=runtime_vision_status_only');
        }

        if (this.containsComplexIntent(content)) {
            intentTags.push('complex_intent');
            styleVector.push('structured');
        }

        if (creatorSession) {
            intentTags.push('creator_private_channel');
            requiresMemoryGrounding = true;
            styleVector.push('execution_oriented');
            styleVector.push('high_continuity');
            forbiddenBehaviors.push('do_not_treat_creator_as_public_viewer');
            requiredFacts.push(`creator_name=${this.creatorDisplayName}`);
            const canon = this.canonicalMemory.getUser(session.key);
            const openGoal = [...session.goals].reverse().find((goal) => goal.status === 'open');
            if (openGoal?.text) {
                requiredFacts.push(`creator_open_goal=${openGoal.text}`);
            }
            if (session.knownFacts.length > 0) {
                requiredFacts.push(`creator_known_facts=${session.knownFacts.slice(-2).join(' | ')}`);
            }
            if (canon?.preferences?.length) {
                const prefs = canon.preferences
                    .slice()
                    .sort((a, b) => b.updatedAt - a.updatedAt)
                    .slice(0, 2)
                    .map((pref) => `${pref.sentiment}:${pref.topic}`)
                    .join(' | ');
                if (prefs) requiredFacts.push(`creator_preferences=${prefs}`);
            }
            if (canon?.tasks?.length) {
                const tasks = canon.tasks
                    .filter((task) => task.status === 'open')
                    .slice(0, 2)
                    .map((task) => task.text)
                    .join(' | ');
                if (tasks) requiredFacts.push(`creator_open_tasks=${tasks}`);
            }
            if (canon?.conflicts?.length) {
                const conflicts = canon.conflicts
                    .slice()
                    .sort((a, b) => b.detectedAt - a.detectedAt)
                    .slice(0, 1)
                    .map((conflict) => `${conflict.kind}:${conflict.detail}`)
                    .join(' | ');
                if (conflicts) requiredFacts.push(`creator_conflict_watch=${conflicts}`);
            }
        }

        const traitControl = TA.resolveActiveTraitControl(this.animeTraitRuntime);
        if (traitControl.enabled) {
            requiredFacts.push(`trait_profile=${traitControl.profile}`);
            requiredFacts.push(`trait_variation=${traitControl.variation.toFixed(2)}`);
            requiredFacts.push(`trait_novelty_target=${traitControl.novelty.toFixed(2)}`);
            styleVector.push(`trait_${traitControl.profile}`);
            if (traitControl.variation >= 0.55 || traitControl.surpriseRate >= 0.6) {
                styleVector.push('high_variability');
            } else if (traitControl.directness >= 0.62) {
                styleVector.push('steady_direct');
            }
        }

        return {
            intentTags,
            requiresMemoryGrounding,
            requiresStateGrounding,
            stateGroundingMode,
            uncertaintyMode,
            requiredFacts,
            forbiddenBehaviors,
            styleVector
        };
    }

    private renderStrategyAsPrompt(strategy: DialogueStrategy): string {
        const lines: string[] = [];
        if (strategy.intentTags.length > 0) {
            lines.push(`- Intent tags: ${strategy.intentTags.join(', ')}`);
        }
        lines.push(`- Memory grounding required: ${strategy.requiresMemoryGrounding ? 'yes' : 'no'}`);
        lines.push(`- State grounding required: ${strategy.requiresStateGrounding ? 'yes' : 'no'} (${strategy.stateGroundingMode})`);
        lines.push(`- Uncertainty mode: ${strategy.uncertaintyMode}`);
        if (strategy.requiredFacts.length > 0) {
            lines.push(`- Required facts: ${strategy.requiredFacts.join('; ')}`);
        }
        if (strategy.forbiddenBehaviors.length > 0) {
            lines.push(`- Forbidden behaviors: ${strategy.forbiddenBehaviors.join(', ')}`);
        }
        if (strategy.styleVector.length > 0) {
            lines.push(`- Style vector: ${strategy.styleVector.join(', ')}`);
        }
        return lines.join('\n');
    }

    private async applyHonestUncertainty(
        reply: string,
        input: RawStreamInput,
        route: ResponseRoute,
        preferCloud: boolean,
        strategy: DialogueStrategy,
        llmHandler: any,
        systemPrompt: string,
        maxTokens: number,
        model?: string
    ): Promise<{ text: string; applied: boolean }> {
        if (!this.honestUncertaintyEnabled) return { text: reply, applied: false };
        const knowledgeSensitive = strategy.uncertaintyMode !== 'off' || TA.isKnowledgeSensitiveQuery(input.content || '');
        if (!knowledgeSensitive) return { text: reply, applied: false };
        if (TA.hasUncertaintyMarker(reply)) {
            this.metrics.uncertaintyStats.detected += 1;
            return { text: reply, applied: false };
        }
        if (preferCloud && !strategy.requiresStateGrounding) return { text: reply, applied: false };
        if (route !== 'slow') return { text: reply, applied: false };
        const rewritePrompt = TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault)
            ? `重写回复，标记不确定部分，保持口语简洁。用户：${input.content}\n回复：${reply}`
            : `Rewrite with honest uncertainty markers. Keep concise. User: ${input.content}\nReply: ${reply}`;
        const rewritten = await llmHandler.generateResponse({
            prompt: rewritePrompt,
            systemPrompt,
            temperature: Math.max(this.llmRetryTemperature, 0.45),
            topP: 0.84,
            maxTokens: Math.min(maxTokens, 140),
            model,
            preferCloud
        });
        if (!isFallbackResponse(rewritten) && rewritten.success && rewritten.text) {
            const text = TA.stripTemplateNoise(stripReasoning((rewritten.text ?? '').toString().trim()));
            if (TA.isMeaningfulText(text) && TA.hasUncertaintyMarker(text)) {
                this.metrics.uncertaintyStats.detected += 1;
                this.metrics.uncertaintyStats.triggered += 1;
                return { text, applied: true };
            }
        }
        return { text: reply, applied: false };
    }

    private detectToolShadow(input: RawStreamInput, route: ResponseRoute): ToolShadowDecision {
        this.metrics.toolShadowStats.evaluated += 1;
        if (!this.toolShadowModeEnabled || route !== 'slow') {
            return { needed: false, reason: 'disabled_or_fast', tools: [] };
        }

        const text = (input.content || '').trim().toLowerCase();
        if (!text) return { needed: false, reason: 'empty_input', tools: [] };

        const tools = new Set<string>();
        let reason = '';

        if (/(天气|气温|weather)/i.test(text)) {
            tools.add('weather');
            reason = reason || 'weather_lookup';
        }
        if (/(汇率|价格|股价|币价|price|rate|stock|crypto)/i.test(text)) {
            tools.add('finance');
            reason = reason || 'market_data';
        }
        if (/(新闻|最新|热点|today|latest|news)/i.test(text)) {
            tools.add('web_search');
            reason = reason || 'recent_info';
        }
        if (/(赛程|战绩|比分|schedule|standings|score)/i.test(text)) {
            tools.add('sports');
            reason = reason || 'sports_data';
        }
        if (/(几点|时区|time|timezone)/i.test(text)) {
            tools.add('time');
            reason = reason || 'time_lookup';
        }
        if (/(时间|日期|星期|几点|几号|time|date|today|weekday)/i.test(text)) {
            tools.add('datetime');
            reason = reason || 'datetime_lookup';
        }
        if (/(计算|算一下|算算|表达式|math|calculate|calculator|\d+\s*[\+\-\*\/\^]\s*\d+)/i.test(text)) {
            tools.add('calculator');
            reason = reason || 'math_calc';
        }
        if (/(随机|抽签|roll|dice|rand|random|选一个)/i.test(text)) {
            tools.add('random');
            reason = reason || 'random_pick';
        }
        if (/(图片|照片|图像|image|photo)/i.test(text)) {
            tools.add('image_search');
            reason = reason || 'image_lookup';
        }

        if (tools.size === 0) {
            return { needed: false, reason: 'no_tool_signal', tools: [] };
        }

        this.metrics.toolShadowStats.triggered += 1;
        return {
            needed: true,
            reason: reason || 'tool_candidate',
            tools: Array.from(tools)
        };
    }

    private buildToolArgs(toolId: string, input: RawStreamInput): Record<string, any> | null {
        const text = (input.content || '').trim();
        if (!text) return null;

        if (toolId === 'datetime') {
            let format: 'full' | 'date' | 'time' = 'full';
            if (/(几点|时间|time|clock)/i.test(text)) format = 'time';
            if (/(日期|几号|哪天|date|day)/i.test(text)) format = 'date';
            return {
                timezone: TA.extractTimezone(text),
                format
            };
        }

        if (toolId === 'calculator') {
            const expression = TA.extractExpression(text);
            if (!expression) return null;
            return { expression };
        }

        if (toolId === 'random') {
            const optionPart = text.split(/[:：]/).slice(1).join(':').trim();
            if (optionPart) {
                const options = optionPart
                    .split(/[，,\/|]/)
                    .map((item) => item.trim())
                    .filter(Boolean);
                if (options.length >= 2) {
                    return { options, count: 1 };
                }
            }
            return { min: 1, max: 100, count: 1 };
        }

        return null;
    }

    private async routeToolViaManager(input: RawStreamInput): Promise<{ toolId: string | null; confidence: number }> {
        try {
            const response = await axios.post(
                `${this.managerEndpoint}/api/tools/route`,
                {
                    userText: input.content || '',
                    userId: input.userId || input.userName || 'viewer',
                    context: {
                        source: input.source
                    }
                },
                { timeout: this.toolRouteTimeoutMs }
            );
            const routing = response.data?.routing || {};
            const toolId = typeof routing.selectedTool === 'string' ? routing.selectedTool : null;
            const confidence = Number.parseFloat(String(routing.confidence ?? 0));
            if (!toolId || !this.allowedToolIds.has(toolId)) {
                return { toolId: null, confidence: 0 };
            }
            return {
                toolId,
                confidence: Number.isFinite(confidence) ? confidence : 0
            };
        } catch {
            return { toolId: null, confidence: 0 };
        }
    }

    private async callToolViaManager(toolId: string, args: Record<string, any>): Promise<ToolCallTrace> {
        const startedAt = Date.now();
        try {
            const response = await axios.post(
                `${this.managerEndpoint}/api/tools/call`,
                {
                    toolId,
                    args,
                    options: {
                        timeoutMs: this.toolExecutionTimeoutMs
                    }
                },
                { timeout: this.toolExecutionTimeoutMs + 800 }
            );
            const durationMs = Date.now() - startedAt;
            const ok = response.status === 200 && response.data?.success && response.data?.status === 'ok';
            if (!ok) {
                return {
                    toolId,
                    status: 'error',
                    durationMs,
                    error: response.data?.error?.message || response.data?.error || 'tool_call_failed'
                };
            }
            const content = TA.extractToolResultContent(response.data);
            if (!TA.isUsefulToolContent(content)) {
                return {
                    toolId,
                    status: 'error',
                    durationMs,
                    error: 'empty_tool_result'
                };
            }
            return {
                toolId,
                status: 'ok',
                durationMs,
                content
            };
        } catch (error: any) {
            return {
                toolId,
                status: 'error',
                durationMs: Date.now() - startedAt,
                error: error?.message || 'tool_call_exception'
            };
        }
    }

    private async executeToolsIfNeeded(
        input: RawStreamInput,
        route: ResponseRoute,
        decision: ToolShadowDecision
    ): Promise<ToolExecutionResult> {
        if (route !== 'slow' || !decision.needed || decision.tools.length === 0) {
            return { mode: this.toolExecutionMode, triggered: false, reason: 'route_or_signal_skip', calls: [] };
        }
        if (!this.toolCallingEnabled) {
            this.metrics.toolExecutionStats.skipped += 1;
            return { mode: this.toolExecutionMode, triggered: true, reason: 'tool_calling_disabled', calls: [] };
        }
        if (this.toolExecutionMode !== 'live') {
            this.metrics.toolExecutionStats.skipped += 1;
            return { mode: 'shadow', triggered: true, reason: 'shadow_mode', calls: [] };
        }

        this.metrics.toolExecutionStats.attempted += 1;
        const routed = await this.routeToolViaManager(input);
        if (routed.toolId) {
            this.metrics.toolExecutionStats.routed += 1;
        }

        const toolQueue: string[] = [];
        if (routed.toolId && routed.confidence >= this.toolRouteMinConfidence) {
            toolQueue.push(routed.toolId);
        }
        for (const raw of decision.tools) {
            const mapped = TA.mapDecisionToolToToolId(raw);
            if (!mapped) continue;
            if (!this.allowedToolIds.has(mapped)) continue;
            if (!toolQueue.includes(mapped)) {
                toolQueue.push(mapped);
            }
        }

        if (toolQueue.length === 0) {
            this.metrics.toolExecutionStats.skipped += 1;
            return {
                mode: 'live',
                triggered: true,
                reason: 'no_supported_tool',
                selectedTool: routed.toolId || undefined,
                confidence: routed.confidence,
                calls: []
            };
        }

        const selectedForExecution = toolQueue[0];
        const calls: ToolCallTrace[] = [];
        for (const toolId of toolQueue.slice(0, this.toolExecutionMaxCalls)) {
            const args = this.buildToolArgs(toolId, input);
            if (!args) {
                calls.push({ toolId, status: 'skipped', durationMs: 0, error: 'missing_args' });
                continue;
            }
            const callResult = await this.callToolViaManager(toolId, args);
            calls.push(callResult);
            if (callResult.status === 'ok') {
                break;
            }
        }

        const successCount = calls.filter((call) => call.status === 'ok').length;
        const errorCount = calls.filter((call) => call.status === 'error').length;
        this.metrics.toolExecutionStats.executed += calls.length;
        this.metrics.toolExecutionStats.succeeded += successCount;
        this.metrics.toolExecutionStats.failed += errorCount;

        const firstError = calls.find((call) => call.status === 'error');
        const reason = successCount > 0
            ? 'tool_executed'
            : (firstError?.error || 'tool_execution_failed');

        return {
            mode: 'live',
            triggered: true,
            reason,
            selectedTool: selectedForExecution,
            confidence: routed.confidence,
            calls
        };
    }

    private buildToolExecutionContext(decision: ToolShadowDecision, execution: ToolExecutionResult): string | null {
        if (!decision.needed || decision.tools.length === 0) return null;

        if (execution.mode !== 'live') {
            return TA.buildToolShadowContext(decision);
        }

        const successRows = execution.calls
            .filter((call) => call.status === 'ok' && TA.isUsefulToolContent(call.content))
            .map((call) => `${call.toolId}: ${call.content}`)
            .slice(0, 2);

        if (successRows.length === 0) {
            return `tool_execution=live reason=${execution.reason} selected=${execution.selectedTool || 'none'} (no usable tool result)`;
        }

        return `tool_execution=live reason=${execution.reason} selected=${execution.selectedTool || 'none'} results=${successRows.join(' | ')}`;
    }

    private pushSessionMessage(session: SessionState, text: string, type: 'user' | 'assistant'): void {
        const clean = (text || '').trim();
        if (!clean) return;
        const target = type === 'assistant' ? session.lastReplies : session.lastUserMessages;
        target.push(clean.slice(0, 200));
        if (type === 'user') {
            session.turnCount += 1;
            this.canonicalMemory.touchInteraction(session.key);
            session.lastUserAt = Date.now();
        } else {
            session.lastAssistantAt = Date.now();
        }
        while (target.length > this.maxSessionMessages) {
            target.shift();
        }
        session.updatedAt = Date.now();
    }

    /** 阶段 A2：每 N 轮用 LLM 生成会话摘要，写入 session.sessionSummary，供下一轮上下文使用 */
    private async generateSessionSummary(session: SessionState, requestId?: string): Promise<string | null> {
        const userMsgs = session.lastUserMessages.slice(-this.sessionSummaryEveryNTurns);
        const assistantMsgs = session.lastReplies.slice(-this.sessionSummaryEveryNTurns);
        if (userMsgs.length === 0 && assistantMsgs.length === 0) return null;
        const lines: string[] = [];
        for (let i = 0; i < Math.max(userMsgs.length, assistantMsgs.length); i++) {
            if (userMsgs[i]) lines.push(`User: ${userMsgs[i]}`);
            if (assistantMsgs[i]) lines.push(`Assistant: ${assistantMsgs[i]}`);
        }
        const dialogue = lines.join('\n');
        if (!dialogue.trim()) return null;
        
        const userName = session.preferredName || 'user';
        const summaryPrompt = `Summarize in 1-2 sentences (name=${userName}, topics, emotions). Same language.

${dialogue}

Summary:`;
        
        try {
            const llmHandler = getGlobalLLMFallbackHandler();
            const result = await this.withSoftTimeout<string | null>(
                'session_summary',
                async () => {
                    const res = await llmHandler.generateResponse({
                        systemPrompt: 'Concise summarizer. Output only summary, under 60 words.',
                        prompt: summaryPrompt,
                        temperature: 0.3,
                        maxTokens: 100
                    });
                    return (res?.text || '').trim() || null;
                },
                this.fastServiceTimeoutMs,
                null
            );
            return result || null;
        } catch (e) {
            if (requestId) console.log(`[SessionSummary] rid=${requestId} error`, (e as Error)?.message);
            return null;
        }
    }

    private maybeUpdateSessionSummary(session: SessionState, requestId?: string): void {
        if (!this.sessionSummaryEnabled) return;
        const n = this.sessionSummaryEveryNTurns;
        if (session.turnCount < n) return;
        if (session.turnCount % n !== 0) return;
        if ((session.lastSummaryTurn ?? 0) >= session.turnCount) return;
        this.generateSessionSummary(session, requestId)
            .then((summary) => {
                if (summary) {
                    session.sessionSummary = summary.slice(0, 300);
                    session.lastSummaryTurn = session.turnCount;
                    if (requestId) console.log(`[SessionSummary] rid=${requestId} turn=${session.turnCount} updated`);
                    this.maybeConsolidateToLongTerm(session, requestId);
                }
            })
            .catch(() => { });
    }

    /** 阶段 B2：相似则更新，否则新增。供 persistVectorStore 与巩固流程复用 */
    private async addOrUpdateMemory(
        record: Omit<import('../memory/types').MemoryRecord, 'id' | 'accessCount' | 'lastAccess'>,
        userId?: string
    ): Promise<void> {
        if (this.memoryUpdateEnabled && userId) {
            const similar = this.vectorStore.search(record.embedding, {
                topK: 1,
                userId,
                minSimilarity: this.memoryUpdateSimilarityThreshold
            });
            if (similar.length > 0) {
                this.vectorStore.update(similar[0].memory.id, {
                    content: record.content,
                    embedding: record.embedding,
                    timestamp: record.timestamp,
                    type: record.type,
                    importance: record.importance,
                    emotionalValence: record.emotionalValence,
                    metadata: record.metadata
                });
                return;
            }
        }
        await this.vectorStore.add(record);
    }

    /** 阶段 B1：将会话摘要压缩为 1~3 条语义记忆写入长期记忆（在摘要更新后异步执行） */
    private maybeConsolidateToLongTerm(session: SessionState, requestId?: string): void {
        if (!this.consolidationEnabled || !this.memoryEnabled) return;
        if (session.turnCount < this.consolidationEveryNTurns || session.turnCount % this.consolidationEveryNTurns !== 0) return;
        const summary = session.sessionSummary;
        const userMsgs = session.lastUserMessages.slice(-this.consolidationEveryNTurns);
        const assistantMsgs = session.lastReplies.slice(-this.consolidationEveryNTurns);
        if (!summary && userMsgs.length === 0 && assistantMsgs.length === 0) return;
        const lines: string[] = [summary ? `Summary: ${summary}` : ''];
        for (let i = 0; i < Math.max(userMsgs.length, assistantMsgs.length); i++) {
            if (userMsgs[i]) lines.push(`User: ${userMsgs[i]}`);
            if (assistantMsgs[i]) lines.push(`Assistant: ${assistantMsgs[i]}`);
        }
        const dialogue = lines.filter(Boolean).join('\n');
        if (!dialogue.trim()) return;
        (async () => {
            try {
                const llmHandler = getGlobalLLMFallbackHandler();
                const res = await llmHandler.generateResponse({
                    systemPrompt: 'Extract 1-3 key facts, one sentence per line. Same language. No preamble.',
                    prompt: `${dialogue.slice(0, 800)}\n\nKey facts:`,
                    temperature: 0.2,
                    maxTokens: 150
                });
                const text = (res?.text || '').trim();
                if (!text) return;
                const facts = text.split(/\n/).map((s) => s.replace(/^\d+[\.\)]\s*/, '').trim()).filter((s) => s.length > 2 && s.length < 200);
                for (const fact of facts.slice(0, 3)) {
                    const encoded = await this.memoryEncoder.encodeSemanticMemory(fact, session.key);
                    await this.addOrUpdateMemory(encoded, session.key);
                }
                if (requestId && facts.length > 0) console.log(`[Consolidation] rid=${requestId} turn=${session.turnCount} facts=${facts.length}`);
            } catch (e) {
                if (requestId) console.log(`[Consolidation] rid=${requestId} error`, (e as Error)?.message);
            }
        })();
    }

    private buildSessionSection(session: SessionState): string {
        const segments: string[] = [];
        const creatorSession = session.isVerified === true;
        const preferredName = this.sanitizePreferredNameCandidate(session.preferredName || '', creatorSession);
        segments.push(`phase=${session.phase}`);
        segments.push(`viewer_tier=${session.viewerTier}`);
        segments.push(`turn_count=${session.turnCount}`);
        if (session.reconnectCount > 0) {
            segments.push(`reconnect_count=${session.reconnectCount}`);
        }
        if (preferredName) {
            segments.push(`preferred_name=${preferredName}`);
        }
        if (session.knownFacts.length > 0) {
            segments.push(`known_facts=${session.knownFacts.slice(-3).join(' | ')}`);
        }
        const canon = this.canonicalMemory.getUser(session.key);
        if (canon?.facts?.length) {
            const canonFacts = canon.facts.slice(-2).join(' | ');
            if (canonFacts) {
                segments.push(`long_term_facts=${canonFacts}`);
            }
        }
        if (canon?.preferences?.length) {
            const prefLine = canon.preferences
                .slice()
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, 2)
                .map((pref) => `${pref.sentiment}:${pref.topic}`)
                .join(' | ');
            if (prefLine) {
                segments.push(`preferences=${prefLine}`);
            }
        }
        if (canon?.tasks?.length) {
            const now = Date.now();
            const stalenessMs = 24 * 60 * 60 * 1000;
            const openTasks = canon.tasks
                .filter((task) => task.status === 'open' && (now - task.updatedAt < stalenessMs))
                .slice(0, 2)
                .map((task) => task.text);
            if (openTasks.length > 0) {
                segments.push(`open_tasks=${openTasks.join(' | ')}`);
            }
        }
        if (canon?.conflicts?.length) {
            const unresolved = canon.conflicts
                .filter((conflict) => !conflict.resolved)
                .slice(0, 1)
                .map((conflict) => `${conflict.kind}:${conflict.detail}`);
            if (unresolved.length > 0) {
                segments.push(`memory_conflict_watch=${unresolved.join(' | ')}`);
            }
        }
        const latestOpen = [...session.goals].reverse().find((goal) => goal.status === 'open');
        if (latestOpen) {
            segments.push(`open_goal=${latestOpen.text}`);
        }
        const doneGoals = session.goals.filter((goal) => goal.status === 'done').length;
        if (doneGoals > 0) {
            segments.push(`done_goals=${doneGoals}`);
        }
        if (session.sessionSummary) {
            segments.push(`session_summary=${session.sessionSummary}`);
        }
        const historyLines: string[] = [];
        const userMsgs = session.lastUserMessages.slice(-5);
        const replyMsgs = session.lastReplies.slice(-5);
        for (let i = 0; i < Math.max(userMsgs.length, replyMsgs.length); i++) {
            if (userMsgs[i]) historyLines.push(`U: ${userMsgs[i]}`);
            if (replyMsgs[i]) historyLines.push(`A: ${replyMsgs[i]}`);
        }
        if (historyLines.length > 0) {
            segments.push(`recent_dialogue:\n${historyLines.join('\n')}`);
        }
        if (session.currentTopic) {
            segments.push(`current_topic=${session.currentTopic}`);
        }
        if (session.currentTopicLabel) {
            segments.push(`topic_label=${session.currentTopicLabel}`);
        }
        if (session.topicFatigue > 0.3) {
            segments.push(`topic_fatigue=${session.topicFatigue.toFixed(2)}`);
        }
        if (segments.length === 0) return '';
        return `\nSession memory:\n${segments.join('\n')}`;
    }

    private buildCreatorChannelSection(input: RawStreamInput, session: SessionState): string {
        if (!TA.isCreatorSession(input)) return '';
        const lines: string[] = [];
        const canon = this.canonicalMemory.getUser(session.key);
        const creatorPreferredName = this.sanitizePreferredNameCandidate(session.preferredName || '', true);
        lines.push(`creator_display_name=${this.creatorDisplayName}`);
        lines.push(`anime_trait_runtime=${this.formatAnimeTraitRuntime()}`);
        lines.push(`llm_cloud_runtime=${this.formatCloudRoutingRuntime()}`);
        if (creatorPreferredName) {
            lines.push(`preferred_name=${creatorPreferredName}`);
        }
        const openGoal = [...session.goals].reverse().find((goal) => goal.status === 'open');
        if (openGoal?.text) {
            lines.push(`open_goal=${openGoal.text}`);
        }
        if (session.lastUserMessages.length > 0) {
            lines.push(`recent_creator_msgs=${session.lastUserMessages.slice(-3).join(' | ')}`);
        }
        if (session.lastReplies.length > 0) {
            lines.push(`recent_assistant_msgs=${session.lastReplies.slice(-2).join(' | ')}`);
        }
        if (session.knownFacts.length > 0) {
            lines.push(`known_facts=${session.knownFacts.slice(-3).join(' | ')}`);
        }
        if (canon?.preferences?.length) {
            const prefs = canon.preferences
                .slice()
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, 4)
                .map((pref) => `${pref.sentiment}:${pref.topic}`);
            if (prefs.length > 0) {
                lines.push(`creator_preferences=${prefs.join(' | ')}`);
            }
        }
        if (canon?.tasks?.length) {
            const openTasks = canon.tasks
                .filter((task) => task.status === 'open')
                .slice(0, 4)
                .map((task) => task.text);
            if (openTasks.length > 0) {
                lines.push(`creator_open_tasks=${openTasks.join(' | ')}`);
            }
        }
        if (canon?.conflicts?.length) {
            const recentConflicts = canon.conflicts
                .slice()
                .sort((a, b) => b.detectedAt - a.detectedAt)
                .slice(0, 2)
                .map((conflict) => `${conflict.kind}:${conflict.detail}`);
            if (recentConflicts.length > 0) {
                lines.push(`creator_conflicts=${recentConflicts.join(' | ')}`);
            }
        }
        return `\nCreator private channel context:\n${lines.join('\n')}`;
    }

    private buildPersonaGuard(session: SessionState, replyLanguage: string): string {
        const creatorSession = session.isVerified === true;
        const preferredName = this.sanitizePreferredNameCandidate(session.preferredName || '', creatorSession);
        const nameRule = preferredName
            ? `- The user's preferred name is "${preferredName}". Use it naturally and do not forget it in this session.`
            : '- If user provides a preferred name, remember it immediately in this session.';
        const tierRule = session.viewerTier === 'core'
            ? '- The user is a core viewer. Keep continuity, warmth, and proactive follow-up.'
            : session.viewerTier === 'regular'
                ? '- The user is a regular viewer. Keep continuity and ask one useful follow-up when suitable.'
                : '- The user is new. Be welcoming and help establish context quickly.';
        return `\nIdentity guard:
- You are ${this.personaName}, a VTuber persona, not a generic assistant.
- If asked "who are you/你是谁/你叫什么, identify yourself as "${this.personaName}".
- Only address user as "${this.creatorDisplayName}" when the session is explicitly creator.
- Never call ordinary viewers "你的创造者/your creator".
- Never expose chain-of-thought or analysis process.
- Avoid meta lines like "As an AI" / "浣滀负AI".
${nameRule}
- If uncertain about factual/time-sensitive claims, say uncertainty explicitly and offer a verifiable next step.
${tierRule}
- Keep reply language ${replyLanguage}.`;
    }

    private buildNeuralStyleGuidance(signal: BrainSignal, agentAnalysis: any, moodInstruction: string): string {
        const style = (signal as any)?.style_guidance || {};
        const constraints = (signal as any)?.reply_constraints || {};
        const trait = (signal as any)?.trait_signal || {};
        const lines: string[] = [];

        if (moodInstruction) {
            lines.push(`- Mood intent: ${moodInstruction}.`);
        }
        if (typeof style.tone === 'string' && style.tone.trim()) {
            lines.push(`- Tone: ${style.tone.trim()}.`);
        }
        if (typeof style.pacing === 'string' && style.pacing.trim()) {
            lines.push(`- Pacing: ${style.pacing.trim()}.`);
        }
        if (typeof style.interaction_goal === 'string' && style.interaction_goal.trim()) {
            lines.push(`- Interaction goal: ${style.interaction_goal.trim()}.`);
        }
        if (typeof style.expressiveness === 'number' && Number.isFinite(style.expressiveness)) {
            lines.push(`- Expressiveness target: ${style.expressiveness.toFixed(2)}.`);
        }
        if (typeof style.kawaii_ratio === 'number' && Number.isFinite(style.kawaii_ratio)) {
            lines.push(`- Kawaii ratio target: ${style.kawaii_ratio.toFixed(2)}.`);
        }
        if (typeof style.surprise_bias === 'number' && Number.isFinite(style.surprise_bias)) {
            lines.push(`- Surprise bias: ${style.surprise_bias.toFixed(2)}.`);
        }
        if (typeof style.roleplay_bias === 'number' && Number.isFinite(style.roleplay_bias)) {
            lines.push(`- Roleplay bias: ${style.roleplay_bias.toFixed(2)}.`);
        }
        if (typeof style.japanese_token_rate === 'number' && Number.isFinite(style.japanese_token_rate)) {
            lines.push(`- Japanese token rate cap: ${style.japanese_token_rate.toFixed(2)}.`);
        }
        if (typeof constraints.max_sentences === 'number' && Number.isFinite(constraints.max_sentences) && constraints.max_sentences > 0) {
            lines.push(`- Keep response within ${Math.floor(constraints.max_sentences)} sentences.`);
        }
        if (Array.isArray(style.avoid_phrases) && style.avoid_phrases.length > 0) {
            lines.push(`- Avoid phrases: ${style.avoid_phrases.slice(0, 6).join(', ')}.`);
        }
        const agentGoal = agentAnalysis?.analysis?.goal;
        if (typeof agentGoal === 'string' && agentGoal.trim()) {
            lines.push(`- Agent goal: ${agentGoal.trim()}.`);
        }
        if (trait?.enabled) {
            if (typeof trait.profile === 'string' && trait.profile.trim()) {
                lines.push(`- Trait profile: ${trait.profile.trim()}.`);
            }
            const styleVector = trait.style_vector || {};
            if (typeof styleVector.tsundere_bias === 'number' && Number.isFinite(styleVector.tsundere_bias)) {
                lines.push(`- Tsundere bias: ${styleVector.tsundere_bias.toFixed(2)}.`);
            }
            if (typeof styleVector.chaos_bias === 'number' && Number.isFinite(styleVector.chaos_bias)) {
                lines.push(`- Chaos bias: ${styleVector.chaos_bias.toFixed(2)}.`);
            }
            if (typeof styleVector.intimacy_bias === 'number' && Number.isFinite(styleVector.intimacy_bias)) {
                lines.push(`- Intimacy bias: ${styleVector.intimacy_bias.toFixed(2)}.`);
            }
            const responsePolicy = trait.response_policy || {};
            if (typeof responsePolicy.novelty_target === 'number' && Number.isFinite(responsePolicy.novelty_target)) {
                lines.push(`- Novelty target: ${responsePolicy.novelty_target.toFixed(2)}.`);
            }
            const loraHint = trait.lora_hint || {};
            if (typeof loraHint.target_style_tag === 'string' && loraHint.target_style_tag.trim()) {
                lines.push(`- LoRA style hint: ${loraHint.target_style_tag.trim()}.`);
            }
            if (typeof loraHint.weight_suggestion === 'number' && Number.isFinite(loraHint.weight_suggestion)) {
                lines.push(`- LoRA weight suggestion: ${loraHint.weight_suggestion.toFixed(2)}.`);
            }
        } else {
            const fallbackTrait = TA.resolveActiveTraitControl(this.animeTraitRuntime, signal);
            if (fallbackTrait.enabled) {
                lines.push(`- Trait profile: ${fallbackTrait.profile}.`);
                lines.push(`- Trait variation: ${fallbackTrait.variation.toFixed(2)}.`);
                lines.push(`- Novelty target: ${fallbackTrait.novelty.toFixed(2)}.`);
                lines.push(`- Surprise bias: ${fallbackTrait.surpriseRate.toFixed(2)}.`);
                lines.push(`- Roleplay bias: ${fallbackTrait.roleplayBias.toFixed(2)}.`);
                lines.push(`- Japanese token rate cap: ${fallbackTrait.japaneseTokenRate.toFixed(2)}.`);
            }
        }

        if (lines.length === 0) return '';
        return `\nNeural style policy:\n${lines.join('\n')}`;
    }

    private buildSystemPrompt(
        route: ResponseRoute,
        maxWords: number,
        moodInstruction: string,
        emotionDetails: string,
        drives: any,
        personalityHint: string,
        memorySection: string,
        agentSection: string,
        sessionSection: string,
        personaGuard: string,
        replyLanguage: string,
        signal: BrainSignal,
        agentAnalysis: any,
        strategy?: DialogueStrategy
    ): string {
        const strategySection = strategy ? `\nPolicy constraints:\n${this.renderStrategyAsPrompt(strategy)}\n` : '';
        if (this.isNeuralPolicyMode() && this.minimalSystemPromptEnabled) {
            const neuralStyle = this.buildNeuralStyleGuidance(signal, agentAnalysis, moodInstruction);
            const minimalSession = this.neuralModeIncludeSessionMemory ? (sessionSection || '') : '';
            const sessionContext = minimalSession ? `\nIMPORTANT CONTEXT (use this information in your reply):\n${minimalSession}\n` : '';
            const streamContext = TA.buildStreamContext();
            return `You are ${this.personaName}, a live VTuber persona streaming right now.
${sessionContext}
${neuralStyle || ''}
${strategySection}
${streamContext}

Rules:
1) Stay in character, natural live-chat tone. Reply language: ${replyLanguage}.
2) Output only the final reply, no meta text. <= ${maxWords} words, <= ${this.emojiMaxCount} emojis.
3) Never parrot, confirm, or ask about what user just said — respond naturally like a real streamer.`;
        }

        if (this.cotHardContractEnabled) {
            const worldHint = moodInstruction || 'natural';
            const baseContext = [memorySection || '', agentSection || '', sessionSection || '', personaGuard, strategySection]
                .filter(Boolean)
                .join('\n');

            return `You are ${this.personaName}, a live VTuber persona for Chinese streaming chat.
Tone & world: ${worldHint}
Emotions: ${emotionDetails || 'neutral'}
Drives: boredom=${(drives.boredom || 0).toFixed(2)}, fatigue=${(drives.fatigue || 0).toFixed(2)}, curiosity=${(drives.curiosity || 0).toFixed(2)}

Context (for internal reasoning only):
${baseContext || 'none'}

Return exactly one JSON object:
{
  "thinking": {
    "observation": "简短观察",
    "intent_analysis": "用户意图分析",
    "social_strategy": "直播互动策略",
    "confidence": 0.0
  },
  "response": "给直播间观众看到的最终回复",
  "meta": {
    "language": "zh|en|mixed",
    "safety": {
      "risk": "low|med|high",
      "notes": "可空"
    }
  }
}

Hard rules:
1) 输出只能是 JSON 对象本体，不要任何额外文本或 Markdown。
2) "response" 必须是可直接发到直播间的自然口语，长度控制在 ${maxWords} 词以内。
3) 不要在 "response" 中提到 JSON、字段名、思考过程或 AI 元话术。
4) "thinking" 仅用于内部调试，保持简洁。`;
        }

        return route === 'fast'
            ? `You are ${this.personaName}, a friendly streaming assistant.
Tone: ${moodInstruction || 'natural'}
Emotions: ${emotionDetails || 'neutral'}
${agentSection || ''}
${sessionSection || ''}
${personaGuard}
${strategySection}

Rules:
1) Reply in <= ${maxWords} words.
2) Be concise and conversational.
3) Output only the final reply.
4) Reply language: ${replyLanguage}.
5) Use zero or very few emojis (at most ${this.emojiMaxCount}).
            `
            : `You are ${this.personaName}, a friendly streaming assistant.
Tone: ${moodInstruction || 'natural'}
Emotions: ${emotionDetails || 'neutral'}
Drives: boredom=${(drives.boredom || 0).toFixed(2)}, fatigue=${(drives.fatigue || 0).toFixed(2)}, curiosity=${(drives.curiosity || 0).toFixed(2)}
${personalityHint || ''}
${memorySection || ''}
${agentSection || ''}
${sessionSection || ''}
${personaGuard}
${strategySection}

Rules:
1) Reply in <= ${maxWords} words.
2) Be concise and conversational.
3) For complex questions you may reason briefly inside \`<think>...</think>\` tags; only content outside \`<think>\` is used as your reply. Otherwise output only the final reply.
4) If Context includes tool execution results, base your reply on those results (observe then respond).
5) Reply language: ${replyLanguage}.
6) Use zero or very few emojis (at most ${this.emojiMaxCount}).
            `;
    }

    private personaConsistencyScore(text: string, input: RawStreamInput, session: SessionState): number {
        let score = 1;
        const content = (text || '').trim();
        if (!content) return 0;
        if (/as an ai|浣滀负ai/i.test(content)) score -= 0.25;
        if (TA.isSelfIdentityQuery(input.content || '') && !content.includes(this.personaName)) score -= 0.2;
        const expectedName = this.getAddressableName(session, input);
        if (TA.isNameRecallQuery(input.content || '') && expectedName && !content.includes(expectedName)) score -= 0.2;
        return Math.max(0, Math.min(1, score));
    }

    private candidateScore(text: string, input: RawStreamInput, session: SessionState, route: ResponseRoute): number {
        const novelty = TA.computeNoveltyScore(text, session);
        const persona = this.personaConsistencyScore(text, input, session);
        const qualityIssue = this.detectQualityIssue(text, input, route, session);
        const quality = qualityIssue ? 0.6 : 1;
        return (novelty * 0.4) + (persona * 0.4) + (quality * 0.2);
    }

    private buildPromptWithHardLimit(base: string, additions: string[]): string {
        const cleanBase = (base || '').trim();
        const sections = additions
            .map((item) => (item || '').trim())
            .filter(Boolean);
        let prompt = cleanBase;
        if (sections.length > 0) {
            prompt = `${cleanBase}\n\n${sections.join('\n')}`.trim();
        }
        if (prompt.length <= this.promptCharsHardLimit) {
            return prompt;
        }
        let current = cleanBase;
        for (const section of sections) {
            const candidate = `${current}\n\n${section}`.trim();
            if (candidate.length > this.promptCharsHardLimit) {
                continue;
            }
            current = candidate;
        }
        if (current.length > this.promptCharsHardLimit) {
            return current.slice(0, this.promptCharsHardLimit);
        }
        return current;
    }

    private buildSamplingPlan(route: ResponseRoute, input: RawStreamInput, session: SessionState, signal?: BrainSignal): { temperature: number; topP: number; noveltyBoost: boolean; } {
        const analysis = TA.analyzeInputComplexity(input.content || '', this.fastPathMaxChars, this.fastPathHardMaxChars);
        const latest = session.lastReplies[session.lastReplies.length - 1] || '';
        const userText = (input.content || '').trim();
        const shortQuery = userText.length <= this.fastPathMaxChars;
        const repeatedPattern = latest ? TA.responseSimilarity(userText, latest) >= 0.5 : false;
        const creativeMode = route === 'slow' && (analysis.complexity >= 0.55 || /(讲个|脑洞|创意|想象|即兴|角色扮演|故事|brainstorm|creative|improv)/i.test(userText));

        let temperature = route === 'fast' ? this.llmFastTemperature : this.llmSlowTemperature;
        let topP = route === 'fast' ? this.llmFastTopP : this.llmSlowTopP;
        let noveltyBoost = false;

        if (creativeMode) {
            temperature = Math.min(0.95, temperature + 0.12);
            topP = Math.min(0.95, topP + 0.04);
            noveltyBoost = true;
        } else if (shortQuery) {
            temperature = Math.max(0.45, temperature - 0.05);
            topP = Math.max(0.75, topP - 0.03);
        }

        if (repeatedPattern) {
            temperature = Math.min(0.92, temperature + 0.08);
            topP = Math.min(0.95, topP + 0.03);
            noveltyBoost = true;
        }

        const traitControl = TA.resolveActiveTraitControl(this.animeTraitRuntime, signal);
        if (traitControl.enabled) {
            const variationShift = (traitControl.variation - this.animeTraitDefault.variation) * 0.28;
            const noveltyShift = (traitControl.novelty - this.animeTraitDefault.noveltyBase) * 0.2;
            temperature += variationShift + noveltyShift;
            topP += noveltyShift * 0.6;

            if (traitControl.profile === 'denpa_chaotic') {
                temperature += 0.05;
                topP += 0.03;
            } else if (traitControl.profile === 'seiso_gentle') {
                temperature -= 0.05;
                topP -= 0.02;
            }

            if (traitControl.surpriseRate >= 0.55 || traitControl.variation >= 0.5 || traitControl.novelty >= 0.52) {
                noveltyBoost = true;
            }

            const factSensitive = TA.isKnowledgeSensitiveQuery(userText) || TA.isRuntimeStateQuery(userText) || TA.isCapabilityScopeQuery(userText);
            if (factSensitive) {
                temperature = Math.min(temperature, route === 'slow' ? 0.72 : 0.64);
                topP = Math.min(topP, 0.9);
            }
        }

        temperature = Math.max(0.35, Math.min(0.96, temperature));
        topP = Math.max(0.7, Math.min(0.98, topP));

        return { temperature, topP, noveltyBoost };
    }

    private detectQualityIssue(
        reply: string,
        input: RawStreamInput,
        route: ResponseRoute,
        session: SessionState
    ): string | null {
        const text = (reply || '').trim();
        if (!TA.isMeaningfulText(text)) return 'empty_or_meaningless';
        const chineseExpected = TA.shouldReplyInChinese(input.content, this.preferChineseByDefault);
        if (TA.hasLanguageMismatch(text, chineseExpected)) return 'language_mismatch';
        if (chineseExpected && TA.hasExcessiveEnglishLeakage(text)) return 'english_leakage';
        if (TA.isEchoLikeReply(text, input.content || '')) return 'echo_reply';
        if (TA.hasEchoLikePrefix(text) && text.length <= 18) return 'ack_only';
        if (/(?:^|\s)follow-up\s*:/i.test(text)) return 'followup_scaffold';
        if (/(要不要我继续|推进到下一步|do you want me to continue|move[\s\S]{0,80}next step)/i.test(text)) return 'followup_scaffold';
        if (/建议选择更有趣或更贴近观众兴趣的话题/i.test(text)) return 'blocked_alternative_template';
        const latest = session.lastReplies[session.lastReplies.length - 1];
        if (latest && latest === text) return 'duplicate_reply';
        // 近似重复检测：novelty < 0.35 意味着与最近回复 >65% 相似
        const novelty = TA.computeNoveltyScore(text, session);
        if (novelty < 0.35) return 'near_duplicate_reply';
        if (TA.isNameRecallQuery(input.content || '')) {
            const expectedName = this.getAddressableName(session, input);
            if (expectedName && !text.includes(expectedName)) return 'name_memory_miss';
        }
        if (TA.isCapabilityScopeQuery(input.content || '') && !TA.hasCapabilityDualStatement(text)) {
            return 'capability_scope_unanswered';
        }
        if (TA.isCapabilityScopeQuery(input.content || '') && TA.hasCapabilityOverclaim(text)) {
            return 'capability_overclaim';
        }
        if (route === 'slow' && TA.isForecastLikeQuery(input.content || '') && !TA.hasUncertaintyMarker(text)) {
            return 'uncertainty_missing';
        }
        const maxWords = route === 'fast' ? this.fastReplyMaxWords : this.slowReplyMaxWords;
        if (!TA.shouldReplyInChinese(input.content, this.preferChineseByDefault)) {
            const words = text.split(/\s+/).filter(Boolean).length;
            if (words > maxWords * 2) return 'too_long';
        } else if (text.length > maxWords * 6) {
            return 'too_long';
        }
        return null;
    }

    private async tryRewriteLowQuality(
        llmHandler: any,
        reply: string,
        input: RawStreamInput,
        systemPrompt: string,
        preferCloud: boolean,
        model: string | undefined,
        maxTokens: number
    ): Promise<string | null> {
        const chinese = TA.shouldReplyInChinese(input.content, this.preferChineseByDefault);
        const rewritePrompt = chinese
            ? `请重写以下回复，要求：1) 保持人设一致；2) 不要"作为AI"类话术；3) 只输出最终回复；4) 用简体中文；5) 不要复读；6) 不要输出"要不要继续/推进下一步"这类流程话术；7) 除专有名词（如 TTS/SoVITS/Live2D）外尽量避免英文。用户消息：${input.content}\n原回复：${reply}`
            : `Rewrite the draft reply to be natural, concise, in-character, and final-answer-only. Do not echo user text and do not output process follow-up scaffolding like "continue to next step". User: ${input.content}\nDraft: ${reply}`;

        const rewrite = await llmHandler.generateResponse({
            prompt: rewritePrompt,
            systemPrompt,
            temperature: this.llmRetryTemperature,
            topP: 0.8,
            maxTokens: Math.min(maxTokens, 140),
            model,
            preferCloud
        });

        if (isFallbackResponse(rewrite) || !rewrite.success || !rewrite.text) {
            return null;
        }

        const polished = TA.stripTemplateNoise(stripReasoning((rewrite.text ?? '').toString().trim()));
        if (!TA.isMeaningfulText(polished)) {
            return null;
        }
        if (TA.hasLanguageMismatch(polished, chinese)) {
            return null;
        }
        return polished;
    }

    private async tryRegenerateForQualityIssue(
        llmHandler: any,
        issue: string,
        reply: string,
        input: RawStreamInput,
        systemPrompt: string,
        preferCloud: boolean,
        model: string | undefined,
        maxTokens: number,
        route: ResponseRoute,
        session: SessionState,
        strategy: DialogueStrategy
    ): Promise<string | null> {
        const chinese = TA.shouldReplyInChinese(input.content, this.preferChineseByDefault);
        const expectedName = this.getAddressableName(session, input);
        const memoryFact = expectedName
            ? (chinese ? `已知用户称呼：${expectedName}` : `Known preferred name: ${expectedName}`)
            : (chinese ? '当前没有用户称呼记忆' : 'Preferred name is currently unknown');
        const strategyBrief = [
            `issue=${issue}`,
            `memoryGrounding=${strategy.requiresMemoryGrounding ? 'yes' : 'no'}`,
            `uncertaintyMode=${strategy.uncertaintyMode}`
        ].join(', ');
        const capabilityConstraintZh = TA.isCapabilityScopeQuery(input.content || '')
            ? '；7) 必须明确写出“我能做什么”和“我目前不能做什么”'
            : '';
        const capabilityConstraintEn = TA.isCapabilityScopeQuery(input.content || '')
            ? '; 7) Explicitly state at least one thing you can do now and one thing you currently cannot do'
            : '';
        const languageConstraintZh = chinese && (issue === 'language_mismatch' || issue === 'english_leakage')
            ? '；8) 除专有名词（如 TTS/SoVITS/Live2D）外，使用简体中文表达'
            : '';

        const prompt = chinese
            ? `上一版回复质量不达标（${strategyBrief}）。请重新直接回答用户问题，要求：1) 不要复述用户原话；2) 不要以"收到/明白/Got it"开头；3) 口语自然、非模板化；4) 不要输出"要不要继续/推进下一步"这类流程话术；5) 若为名字/身份问，必须基于记忆事实（${memoryFact}）；6) 若涉及未来或不确定信息，明确不确定并给出可验证下一步${capabilityConstraintZh}${languageConstraintZh}。只输出最终回复。用户消息：${input.content}\n低质量回复：${reply}`
            : `Previous reply quality is not acceptable (${strategyBrief}). Regenerate a direct answer: do not echo user text, do not start with acknowledgment tokens, keep natural non-templated tone, avoid process follow-up scaffolding, ground identity/name answers in memory facts (${memoryFact}), and mark uncertainty with one verifiable next step for forecast-like claims${capabilityConstraintEn}. Output final reply only. User: ${input.content}\nLow-quality reply: ${reply}`;

        const regenerated = await llmHandler.generateResponse({
            prompt,
            systemPrompt,
            temperature: Math.max(this.llmRetryTemperature, route === 'slow' ? 0.58 : 0.5),
            topP: route === 'slow' ? 0.9 : 0.84,
            maxTokens: Math.min(maxTokens, 160),
            model,
            preferCloud
        });

        if (isFallbackResponse(regenerated) || !regenerated.success || !regenerated.text) {
            return null;
        }

        const polished = TA.stripTemplateNoise(stripReasoning((regenerated.text ?? '').toString().trim()));
        if (!TA.isMeaningfulText(polished)) return null;
        if (TA.hasLanguageMismatch(polished, chinese)) return null;
        if (this.detectQualityIssue(polished, input, route, session)) return null;
        return polished;
    }

    private async tryRegenerateForStateGrounding(
        llmHandler: any,
        issue: string,
        reply: string,
        input: RawStreamInput,
        systemPrompt: string,
        preferCloud: boolean,
        model: string | undefined,
        maxTokens: number,
        strategy: DialogueStrategy,
        evidence: RuntimeStateEvidence | null
    ): Promise<string | null> {
        const chinese = TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault);
        const evidenceLine = evidence?.available
            ? `runtime_state_evidence=${evidence.summary}`
            : 'runtime_state_evidence=unavailable';
        const prompt = chinese
            ? `上一版回复触发状态接地问题（${issue}）。请基于证据重写：${evidenceLine}。要求：1) 不编造当前状态；2) 证据不足时明确不确定；3) 只输出最终回复。用户消息：${input.content}\n原回复：${reply}`
            : `The previous reply has a state-grounding issue (${issue}). Rewrite grounded on evidence: ${evidenceLine}. Requirements: do not fabricate runtime state; if evidence is unavailable, express uncertainty explicitly; output final conversational answer only. User: ${input.content}\nCurrent reply: ${reply}`;
        const regenerated = await llmHandler.generateResponse({
            prompt,
            systemPrompt,
            temperature: Math.max(this.llmRetryTemperature, 0.45),
            topP: 0.82,
            maxTokens: Math.min(maxTokens, 160),
            model,
            preferCloud
        });
        if (isFallbackResponse(regenerated) || !regenerated.success || !regenerated.text) {
            return null;
        }
        const polished = TA.stripTemplateNoise(stripReasoning((regenerated.text ?? '').toString().trim()));
        if (!TA.isMeaningfulText(polished)) return null;
        if (TA.hasLanguageMismatch(polished, chinese)) return null;
        if (this.detectStateGroundingIssue(polished, input, strategy, evidence)) return null;
        return polished;
    }

    private async tryDirectAnswerRepair(
        llmHandler: any,
        input: RawStreamInput,
        route: ResponseRoute,
        session: SessionState,
        strategy: DialogueStrategy,
        preferCloud: boolean,
        model: string | undefined,
        maxTokens: number
    ): Promise<string | null> {
        const chinese = TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault);
        const expectedName = this.getAddressableName(session, input);
        const memoryHint = expectedName
            ? (chinese ? `已知用户称呼=${expectedName}` : `known preferred_name=${expectedName}`)
            : (chinese ? '当前没有用户称呼记忆' : 'preferred_name_unknown');
        const repairSystemPrompt = chinese
            ? `你是${this.personaName}，正在直播互动。只输出一条直接回答，不要流程控制话术，不要“收到/Got it”式开场，也不要“继续下一步”。`
            : `You are ${this.personaName} in live chat. Output one direct answer only. No process scaffolding, no acknowledgment opener, no "continue to next step".`;
        const capabilityConstraintZh = TA.isCapabilityScopeQuery(input.content || '')
            ? '；4) 对能力问题必须同时写出“我能做什么”和“我目前不能做什么”'
            : '';
        const capabilityConstraintEn = TA.isCapabilityScopeQuery(input.content || '')
            ? '; for capability questions, explicitly include both what you can do and what you currently cannot do'
            : '';
        const repairPrompt = chinese
            ? `直接回答用户消息：${input.content}\n约束：1) 口语自然，非模板化；2) 不要复述原问题；3) 若是名字/身份问题，基于记忆(${memoryHint})；4) 若涉及预测，要明确不确定并给一个可验证下一步${capabilityConstraintZh}。`
            : `Directly answer this user message: ${input.content}\nConstraints: natural non-templated tone, do not echo the question, ground identity/name answers in memory (${memoryHint}), and for forecast-like queries mark uncertainty with one verifiable next step${capabilityConstraintEn}.`;

        const repaired = await llmHandler.generateResponse({
            prompt: repairPrompt,
            systemPrompt: repairSystemPrompt,
            temperature: Math.max(this.llmRetryTemperature, route === 'slow' ? 0.58 : 0.5),
            topP: route === 'slow' ? 0.9 : 0.84,
            maxTokens: Math.min(maxTokens, 160),
            model,
            preferCloud
        });
        if (isFallbackResponse(repaired) || !repaired.success || !repaired.text) {
            return null;
        }
        const polished = TA.stripTemplateNoise(stripReasoning((repaired.text ?? '').toString().trim()));
        if (!TA.isMeaningfulText(polished)) return null;
        if (this.detectQualityIssue(polished, input, route, session)) return null;
        if (strategy.uncertaintyMode !== 'off' && TA.isForecastLikeQuery(input.content || '') && !TA.hasUncertaintyMarker(polished)) {
            return null;
        }
        return polished;
    }

    private isPredictionAlternativeAcceptable(
        alternative: string,
        input: RawStreamInput,
        route: ResponseRoute,
        session: SessionState
    ): boolean {
        const text = (alternative || '').trim();
        if (!TA.isMeaningfulText(text)) return false;
        if (/建议选择更有趣或更贴近观众兴趣的话题/i.test(text)) return false;
        const qualityIssue = this.detectQualityIssue(text, input, route, session);
        return !qualityIssue;
    }

    private buildContextBudget(
        memoryContext: MemoryContext | null,
        input: RawStreamInput,
        route: ResponseRoute,
        session: SessionState
    ): ContextBudgetResult {
        if (!memoryContext) {
            return {
                section: '',
                rawCount: 0,
                selectedCount: 0,
                tokensBefore: 0,
                tokensAfter: 0,
                hardNegativeDropped: 0,
                lexicalAccepted: 0
            };
        }

        const raw = Array.isArray(memoryContext.relatedMemories) ? memoryContext.relatedMemories : [];
        const rawTexts = raw.map((item) => item.memory?.content || '').filter(Boolean);
        const rawSummary = memoryContext.summary || '';
        const tokensBefore = TA.estimateTokenCount(`${rawSummary}\n${rawTexts.join('\n')}`);

        if (raw.length === 0 && !memoryContext.userProfile && session.knownFacts.length === 0) {
            return {
                section: '',
                rawCount: 0,
                selectedCount: 0,
                tokensBefore,
                tokensAfter: 0,
                hardNegativeDropped: 0,
                lexicalAccepted: 0
            };
        }

        const maxEntries = route === 'fast' ? this.memoryBudgetMaxEntriesFast : this.memoryBudgetMaxEntriesSlow;
        const charBudget = route === 'fast' ? this.memoryBudgetCharsFast : this.memoryBudgetCharsSlow;

        const sorted = [...raw].sort((a, b) => b.relevance - a.relevance);
        const topScore = sorted[0]?.relevance || 0;
        const threshold = Math.max(topScore * this.memoryAdaptiveRatio, this.memoryAdaptiveMinScore);

        let selected = sorted.filter((item) =>
            item.relevance >= threshold || item.similarity >= 0.48
        );

        const queryText = (input.content || '').trim();
        let hardNegativeDropped = 0;
        let lexicalAccepted = 0;
        selected = selected.filter((item) => {
            const memoryText = item.memory?.content || '';
            const lexical = TA.lexicalOverlapScore(queryText, memoryText);
            const lexicalPass = lexical >= this.memoryHardNegativeLexicalMin;
            const recencyBoost = item.recency >= 0.16;
            const semanticPass = item.similarity >= this.memoryHardNegativeSimilarity;
            const pass = semanticPass
                ? (lexicalPass || recencyBoost)
                : (item.relevance >= threshold && item.recency > 0.02 && (lexicalPass || recencyBoost));
            if (!pass) {
                hardNegativeDropped += 1;
            } else if (lexicalPass) {
                lexicalAccepted += 1;
            }
            return pass;
        });

        if (selected.length === 0 && sorted.length > 0) {
            selected = [sorted[0]];
        }

        const seen = new Set<string>();
        const deduped: typeof selected = [];
        for (const item of selected) {
            const key = TA.normalizeMemoryKey((item.memory?.content || '').slice(0, 80));
            if (!key || seen.has(key)) continue;
            seen.add(key);
            deduped.push(item);
            if (deduped.length >= maxEntries) break;
        }

        const reordered = [...deduped];
        if (reordered.length >= 3) {
            const first = reordered[0];
            const second = reordered[1];
            const middle = reordered.slice(2);
            middle.sort((a, b) => b.relevance - a.relevance);
            reordered.length = 0;
            reordered.push(first, ...middle, second);
        }

        const lines: string[] = [];
        if (memoryContext.userProfile?.totalInteractions) {
            const profile = memoryContext.userProfile;
            const tagText = profile.tags.length > 0 ? ` tags=${profile.tags.slice(0, 3).join('|')}` : '';
            lines.push(`layer.user_profile: interactions=${profile.totalInteractions}${tagText}`);
            if (this.memoryLongTermCoreMax > 0 && profile.coreMemories?.length) {
                const core = profile.coreMemories
                    .slice(0, this.memoryLongTermCoreMax)
                    .map((x) => x.replace(/\s+/g, ' ').trim())
                    .filter(Boolean)
                    .map((x) => (x.length > 90 ? `${x.slice(0, 90)}...` : x));
                if (core.length > 0) {
                    lines.push(`layer.long_term_core: ${core.join(' | ')}`);
                }
            }
        }
        const canon = this.canonicalMemory.getUser(session.key);
        if (canon?.facts?.length) {
            lines.push(`layer.long_term_facts: ${canon.facts.slice(-2).join(' | ')}`);
        }
        if (canon?.preferences?.length) {
            const prefs = canon.preferences
                .slice()
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, 3)
                .map((pref) => `${pref.sentiment}:${pref.topic}`)
                .join(' | ');
            if (prefs) {
                lines.push(`layer.volatile_prefs: ${prefs}`);
            }
        }
        if (canon?.tasks?.length) {
            const openTasks = canon.tasks
                .filter((task) => task.status === 'open')
                .slice(0, 3)
                .map((task) => task.text)
                .join(' | ');
            if (openTasks) {
                lines.push(`layer.open_tasks: ${openTasks}`);
            }
        }
        if (session.knownFacts.length > 0) {
            lines.push(`layer.session_facts: ${session.knownFacts.slice(-2).join(' | ')}`);
        }

        for (const item of reordered) {
            const content = (item.memory?.content || '').replace(/\s+/g, ' ').trim();
            if (!content) continue;
            const clipped = content.length > 120 ? `${content.slice(0, 120)}...` : content;
            lines.push(`mem[${TA.formatMemoryTime(item.memory.timestamp)}|r=${item.relevance.toFixed(2)}|s=${item.similarity.toFixed(2)}]: ${clipped}`);
        }

        const packed: string[] = [];
        let usedChars = 0;
        for (const line of lines) {
            if (usedChars + line.length > charBudget) break;
            packed.push(line);
            usedChars += line.length + 1;
        }

        const section = packed.length > 0 ? `\nContext hints:\n${packed.join('\n')}` : '';
        const tokensAfter = TA.estimateTokenCount(section);

        const metrics: ContextBudgetResult = {
            section,
            rawCount: raw.length,
            selectedCount: packed.length,
            tokensBefore,
            tokensAfter,
            hardNegativeDropped,
            lexicalAccepted
        };
        this.metrics.recordContextBudget(metrics);

        console.log(
            `[ContextBudget] rid=${input.requestId || 'na'} route=${route} raw=${raw.length} selected=${packed.length} tokens_before=${tokensBefore} tokens_after=${tokensAfter}`
        );

        return metrics;
    }

    private enforceConsistencyGuard(
        reply: string,
        input: RawStreamInput,
        route: ResponseRoute,
        session: SessionState
    ): { text: string; flags: string[] } {
        let text = TA.stripTemplateNoise(reply || '');
        text = TA.normalizeChineseTechnicalTerms(text, TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault));
        text = TA.stripExcessiveEmoji(text, this.emojiMaxCount);
        const flags: string[] = [];

        // Remove internal follow-up/meta scaffolding from live-facing output.
        const beforeCleanup = text;
        text = text
            .replace(/(?:^|\s)Follow-up:\s*/gi, ' ')
            .replace(/要不要我继续把[\s\S]{0,160}?推进到下一步[。？?]?/g, '')
            .replace(/Do you want me to continue and move [\s\S]{0,160}? to the next step\??/gi, '')
            .replace(/建议选择更有趣或更贴近观众兴趣的话题[。！？?]?/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
        if (text !== beforeCleanup) {
            flags.push('meta_followup_removed');
        }

        if (/as an ai|浣滀负ai/i.test(text)) {
            text = text.replace(/as an ai[^,.!?:锛屻€傦紒锛燂細]*[,.!?:锛屻€傦紒锛燂細]?\s*/ig, '');
            text = text.replace(/作为ai[^，。！？:]*[，。！？:]?\s*/ig, '');
            flags.push('style_meta_removed');
        }

        const recallQuery = TA.isNameRecallQuery(input.content || '');
        const selfIdentityQuery = TA.isSelfIdentityQuery(input.content || '');
        const userIdentityQuery = TA.isUserIdentityQuery(input.content || '');
        if (recallQuery) {
            this.metrics.consistencyStats.nameQueries += 1;
        }
        const expectedName = this.getAddressableName(session, input);

        if (this.isNeuralPolicyMode() && this.neuralModeMinimalConsistencyGuard) {
            const maxWords = route === 'fast' ? this.fastReplyMaxWords : this.slowReplyMaxWords;
            if (TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault)) {
                const maxChars = maxWords * 6;
                if (text.length > maxChars) {
                    text = `${text.slice(0, maxChars).trim()}...`;
                    flags.push('length_trimmed');
                }
            } else {
                const words = text.split(/\s+/).filter(Boolean);
                if (words.length > maxWords * 2) {
                    text = `${words.slice(0, maxWords * 2).join(' ')}...`;
                    flags.push('length_trimmed');
                }
            }
            if (expectedName && (recallQuery || userIdentityQuery)) {
                const zhFirstPersonPattern = /(我叫|我的名字是)\s*([A-Za-z0-9_\-\u4e00-\u9fff]{1,24})/;
                const enFirstPersonPattern = /(my name is\s*)([A-Za-z][A-Za-z0-9_\-]{0,23})/i;
                if (zhFirstPersonPattern.test(text)) {
                    text = text.replace(zhFirstPersonPattern, `浣犲彨${expectedName}`);
                    flags.push('name_pronoun_fixed');
                }
                if (enFirstPersonPattern.test(text)) {
                    text = text.replace(enFirstPersonPattern, `your name is ${expectedName}`);
                    flags.push('name_pronoun_fixed');
                }
                if (!text.includes(expectedName)) {
                    const prefix = TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault)
                        ? `你叫${expectedName}。`
                        : `Your name is ${expectedName}. `;
                    text = `${prefix}${text}`.trim();
                    flags.push('name_recall_injected');
                }
            }
            if (selfIdentityQuery && !text.includes(this.personaName)) {
                const intro = TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault)
                    ? `我是${this.personaName}。`
                    : `I am ${this.personaName}. `;
                text = `${intro}${text}`.trim();
                flags.push('persona_name_injected');
            }
            if (!TA.isMeaningfulText(text)) {
                text = this.buildRescueReply(input.content || '');
                flags.push('fallback_rescue');
            }
            const noEmoji = TA.stripExcessiveEmoji(text, this.emojiMaxCount);
            if (noEmoji !== text) {
                text = noEmoji;
                flags.push('emoji_trimmed');
            }
            const sanitized = this.sanitizeUnsafePublicIdsInReply(text, input, expectedName);
            if (sanitized.changed) {
                text = sanitized.text;
                flags.push('unsafe_public_id_sanitized');
            }
            if (!TA.isMeaningfulText(text)) {
                text = this.buildRescueReply(input.content || '');
                flags.push('fallback_rescue');
            }
            return { text, flags };
        }
        if (expectedName && recallQuery) {
            const expected = expectedName;
            const zhNamePattern = /(浣?鍙珅鏄?\s*)([A-Za-z0-9_\-\u4e00-\u9fff]{1,24})/;
            const enNamePattern = /(your name is\s*)([A-Za-z][A-Za-z0-9_\-]{0,23})/i;
            const zhFirstPersonPattern = /(我叫|我的名字是)\s*([A-Za-z0-9_\-\u4e00-\u9fff]{1,24})/;
            const enFirstPersonPattern = /(my name is\s*)([A-Za-z][A-Za-z0-9_\-]{0,23})/i;
            const zhMatch = text.match(zhNamePattern);
            const enMatch = text.match(enNamePattern);
            const zhFirstPersonMatch = text.match(zhFirstPersonPattern);
            const enFirstPersonMatch = text.match(enFirstPersonPattern);

            if (zhMatch?.[3] && zhMatch[3] !== expected) {
                text = text.replace(zhNamePattern, `$1${expected}`);
                flags.push('name_conflict_fixed');
            }
            if (enMatch?.[2] && enMatch[2] !== expected) {
                text = text.replace(enNamePattern, `$1${expected}`);
                flags.push('name_conflict_fixed');
            }
            if (zhFirstPersonMatch?.[3]) {
                text = text.replace(zhFirstPersonPattern, `浣犲彨${expected}`);
                flags.push('name_pronoun_fixed');
            }
            if (enFirstPersonMatch?.[2]) {
                text = text.replace(enFirstPersonPattern, `your name is ${expected}`);
                flags.push('name_pronoun_fixed');
            }

            if (recallQuery && !text.includes(expected)) {
                const prefix = TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault)
                    ? `你叫${expected}。`
                    : `Your name is ${expected}. `;
                text = `${prefix}${text}`.trim();
                flags.push('name_recall_injected');
            }
            if (recallQuery && text.includes(expected)) {
                flags.push('name_query_hit');
            }
        } else if (recallQuery) {
            flags.push('name_query_no_memory');
        }

        if (selfIdentityQuery) {
            const oldPersonaAliases = ['Jieice', 'jieice', '洁艾丝', '杰艾丝'];
            for (const alias of oldPersonaAliases) {
                if (alias && text.includes(alias)) {
                    text = text.split(alias).join(this.personaName);
                    flags.push('persona_name_fixed');
                }
            }
            const isZh = TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault);
            const hasPersona = text.includes(this.personaName);
            if (!hasPersona) {
                const intro = isZh
                    ? `我是${this.personaName}。`
                    : `I am ${this.personaName}. `;
                text = `${intro}${text}`.trim();
                flags.push('persona_name_injected');
            }
            const isCreatorSession = TA.isCreatorSession(input);
            if (isCreatorSession && isZh && !text.includes(this.creatorDisplayName)) {
                text = `${this.creatorDisplayName}锛?{text}`;
                flags.push('creator_address_injected');
            }
        }

        if (userIdentityQuery) {
            if (expectedName) {
                if (!text.includes(expectedName)) {
                    text = `${expectedName} ${text}`.trim();
                    flags.push('user_identity_grounded');
                }
            } else {
                flags.push('user_identity_no_memory');
            }
        }

        const creatorTopic = /(\u521b\u9020\u8005|creator|\u5f00\u53d1\u8005|made you|created you)/i.test(input.content || '');
        const creatorSession = TA.isCreatorSession(input);
        if (!creatorTopic && !creatorSession) {
            const before = text;
            text = text
                .replace(/\u4f60\u662f\u4f60\u7684\u521b\u9020\u8005/gu, `你是${this.personaName}的朋友`)
                .replace(/\u4f60\u7684\u521b\u9020\u8005/gu, '你的朋友')
                .replace(/\u6211\u7684\u521b\u9020\u8005/gu, '我的朋友')
                .replace(/your creator/gi, 'your friend')
                .replace(/my creator/gi, 'my friend')
                .replace(/\s{2,}/g, ' ')
                .trim();
            if (text !== before) {
                flags.push('creator_phrase_sanitized');
            }
        }

        const maxWords = route === 'fast' ? this.fastReplyMaxWords : this.slowReplyMaxWords;
        if (TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault)) {
            const maxChars = maxWords * 6;
            if (text.length > maxChars) {
                text = `${text.slice(0, maxChars).trim()}...`;
                flags.push('length_trimmed');
            }
        } else {
            const words = text.split(/\s+/).filter(Boolean);
            if (words.length > maxWords * 2) {
                text = `${words.slice(0, maxWords * 2).join(' ')}...`;
                flags.push('length_trimmed');
            }
        }

        if (!TA.isMeaningfulText(text)) {
            text = this.buildRescueReply(input.content || '');
            flags.push('fallback_rescue');
        }
        const noEmoji = TA.stripExcessiveEmoji(text, this.emojiMaxCount);
        if (noEmoji !== text) {
            text = noEmoji;
            flags.push('emoji_trimmed');
        }
        const sanitized = this.sanitizeUnsafePublicIdsInReply(text, input, expectedName);
        if (sanitized.changed) {
            text = sanitized.text;
            flags.push('unsafe_public_id_sanitized');
        }
        if (!TA.isMeaningfulText(text)) {
            text = this.buildRescueReply(input.content || '');
            flags.push('fallback_rescue');
        }

        return { text, flags };
    }

    private getServiceTimeout(route: ResponseRoute): number {
        return route === 'fast' ? this.fastServiceTimeoutMs : this.optionalServiceTimeoutMs;
    }

    async withSoftTimeout<T>(
        label: string,
        operation: () => Promise<T>,
        timeoutMs: number,
        fallback: T
    ): Promise<T> {
        let finished = false;

        return new Promise<T>((resolve) => {
            const timer = setTimeout(() => {
                if (finished) return;
                finished = true;
                console.warn(`[Perf] stage=${label} soft-timeout ${timeoutMs}ms`);
                resolve(fallback);
            }, timeoutMs);

            Promise.resolve()
                .then(operation)
                .then((value) => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    resolve(value);
                })
                .catch((error: any) => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    console.warn(`[Perf] stage=${label} failed: ${error?.message || error}`);
                    resolve(fallback);
                });
        });
    }

    private runSelfCritic(reply: string, input: RawStreamInput, session: SessionState, route: ResponseRoute): SelfCriticResult {
        if (!this.selfCriticEnabled) {
            return { issues: [], score: 1 };
        }

        const issues: string[] = [];
        const text = (reply || '').trim();
        if (!TA.isMeaningfulText(text)) {
            issues.push('empty');
        }
        if (/as an ai|浣滀负ai/i.test(text)) {
            issues.push('meta_style');
        }
        if (TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault) && !/[\u4e00-\u9fff]/.test(text)) {
            issues.push('language_mismatch');
        }
        if (TA.isNameRecallQuery(input.content || '')) {
            const expected = this.getAddressableName(session, input);
            if (expected && !text.includes(expected)) {
                issues.push('name_recall_miss');
            }
        }
        if (route === 'slow' && TA.isKnowledgeSensitiveQuery(input.content || '') && !TA.hasUncertaintyMarker(text)) {
            issues.push('uncertainty_missing');
        }

        let score = 1;
        score -= issues.length * 0.22;
        if (route === 'fast' && text.length > this.fastReplyMaxWords * 6) score -= 0.1;
        if (route === 'slow' && text.length > this.slowReplyMaxWords * 8) score -= 0.1;
        score = Math.max(0, Math.min(1, score));

        return { issues, score };
    }

    private containsComplexIntent(text: string): boolean {
        const analysis = TA.analyzeInputComplexity(text, this.fastPathMaxChars, this.fastPathHardMaxChars);
        return analysis.complexity >= this.routeComplexityThreshold;
    }

    private shouldUseRealtimeGuard(input: RawStreamInput, route: ResponseRoute): boolean {
        if (!this.liveRealtimeModeEnabled) return false;
        if (!TA.isLiveForegroundTurn(input)) return false;
        return route === 'fast' || route === 'slow';
    }

    private getLlmRequestTimeoutMs(input: RawStreamInput, route: ResponseRoute): number {
        if (this.shouldUseRealtimeGuard(input, route)) {
            return route === 'fast' ? this.liveFastLlmTimeoutMs : this.liveSlowLlmTimeoutMs;
        }
        if (route === 'fast') {
            return Math.max(this.liveFastLlmTimeoutMs, 2600);
        }
        return Math.max(this.liveSlowLlmTimeoutMs, 7000);
    }

    private shouldPreferCloud(route: ResponseRoute, input: RawStreamInput): boolean {
        if (route !== 'slow' || !this.slowPathCloudEnabled || !TA.hasCloudKey()) {
            return false;
        }
        if (this.llmCloudRuntimeMode === 'off') {
            return false;
        }
        if (this.llmCloudRuntimeMode === 'on') {
            return true;
        }
        if (this.slowPathCloudAlways) {
            return true;
        }
        const isComplex = this.containsComplexIntent(input.content || '');
        if (this.slowPathCloudComplexOnly) {
            return isComplex;
        }
        if (isComplex) return true;
        if (!this.slowPathCloudAllowRandom) return false;
        return Math.random() < this.slowPathCloudProbability;
    }

    private decideInitialRoute(input: RawStreamInput): ResponseRoute {
        if (input.routeHint === 'fast' || input.routeHint === 'slow') {
            return input.routeHint;
        }
        if (input.processingMode === 'background') {
            return 'slow';
        }
        if (!this.fastPathEnabled) return 'slow';
        if (input.source === 'creator') return 'slow';
        const t = (input.content || '').trim();
        if (!t) return 'slow';
        if (t.length > this.fastPathHardMaxChars) return 'slow';
        if (TA.isRuntimeStateQuery(t)) return 'slow';
        if (TA.isCapabilityScopeQuery(t)) return 'slow';
        if (TA.isVisualCapabilityQuery(t)) return 'slow';
        if (TA.isMemoryGroundingQuery(t)) return 'slow';

        const analysis = TA.analyzeInputComplexity(t, this.fastPathMaxChars, this.fastPathHardMaxChars);
        if (analysis.complexity >= this.routeComplexityThreshold) return 'slow';
        if (analysis.confidence < this.routeConfidenceThreshold) return 'slow';
        return 'fast';
    }

    private inferRouteReason(input: RawStreamInput, route: ResponseRoute, stage: 'initial' | 'rule' = 'initial'): string {
        if (input.routeHint === 'fast' || input.routeHint === 'slow') {
            return `route_hint_${input.routeHint}`;
        }
        if (stage === 'rule') return 'rule_signal';
        if (input.processingMode === 'background') return 'background_mode';
        if (input.source === 'creator') return 'creator_source';
        const t = (input.content || '').trim();
        if (!t) return 'empty_input';
        if (t.length > this.fastPathHardMaxChars) return 'length_hard_limit';
        if (TA.isRuntimeStateQuery(t)) return 'runtime_state_query';
        if (TA.isCapabilityScopeQuery(t)) return 'capability_scope_query';
        if (TA.isVisualCapabilityQuery(t)) return 'visual_capability_query';
        if (TA.isMemoryGroundingQuery(t)) return 'memory_grounding_query';
        const analysis = TA.analyzeInputComplexity(t, this.fastPathMaxChars, this.fastPathHardMaxChars);
        if (analysis.complexity >= this.routeComplexityThreshold) return 'complexity_threshold';
        if (analysis.confidence < this.routeConfidenceThreshold) return 'low_confidence';
        return route === 'fast' ? 'short_simple' : 'default_slow';
    }

    private decideModuleParticipationLevel(
        route: ResponseRoute,
        analysis: ComplexityAnalysis,
        overloaded: boolean,
        content: string
    ): ModuleParticipationLevel {
        if (overloaded) return 'minimal';
        if (route === 'fast' && analysis.complexity <= this.fastPathSimpleComplexityThreshold) return 'minimal';
        if (route === 'slow' && (analysis.complexity >= Math.min(1, this.routeComplexityThreshold + 0.2) || this.containsComplexIntent(content || ''))) {
            return 'full';
        }
        return 'balanced';
    }

    private buildDefaultSignal(input: RawStreamInput): BrainSignal {
        const traitControl = TA.resolveActiveTraitControl(this.animeTraitRuntime);
        const fallbackStyleGuidance = TA.buildFallbackStyleGuidance(traitControl);
        const fallbackTraitSignal = TA.buildFallbackTraitSignal(traitControl);
        return {
            text: input.content,
            policy: [],
            actions: [],
            soul: {
                emotion: {
                    joy: 0.35,
                    sadness: 0.15,
                    anger: 0.1
                },
                drives: {
                    boredom: 0.2,
                    fatigue: 0.2,
                    curiosity: 0.5,
                    social_need: 0.6
                },
                personality: 'balanced'
            },
            style_guidance: fallbackStyleGuidance,
            reply_constraints: {
                max_sentences: traitControl.variation >= 0.55 ? 4 : 3
            },
            trait_runtime: this.buildAnimeTraitRuntimePayload(),
            trait_signal: fallbackTraitSignal
        };
    }

    private appendCotTrace(record: CotTraceRecord): void {
        TA.runDetached('cot_trace_append', async () => {
            TA.ensureTraceDirExists(this.cotTracePath);
            const line = JSON.stringify(record);
            await fs.promises.appendFile(this.cotTracePath, `${line}\n`, 'utf-8');
        });
    }

    private appendBadCotSample(record: CotTraceRecord): void {
        TA.runDetached('cot_bad_sample_append', async () => {
            TA.ensureTraceDirExists(this.cotBadSamplePath);
            const line = JSON.stringify(record);
            await fs.promises.appendFile(this.cotBadSamplePath, `${line}\n`, 'utf-8');
        });
    }

    private applyNoThinkDirective(userText: string): string {
        const text = (userText || '').trim();
        if (!text) return text;
        if (!this.forceNoThink) return text;
        // Respect explicit user override.
        if (/(^|\s)\/think(\s|$)/i.test(text) || /(^|\s)\/no_think(\s|$)/i.test(text)) {
            return text;
        }
        return `${text}\n/no_think`;
    }

    private isAnimeTraitProfile(value: string): value is AnimeTraitProfile {
        return this.animeTraitProfiles.includes(value as AnimeTraitProfile);
    }

    private formatAnimeTraitRuntime(): string {
        return `enabled=${this.animeTraitRuntime.enabled ? 'on' : 'off'}, profile=${this.animeTraitRuntime.profile}, variation=${this.animeTraitRuntime.variation.toFixed(2)}, novelty=${this.animeTraitRuntime.noveltyBase.toFixed(2)}`;
    }

    private buildAnimeTraitRuntimePayload(): { enabled: boolean; profile: AnimeTraitProfile; variation: number; novelty_base: number } {
        return {
            enabled: this.animeTraitRuntime.enabled,
            profile: this.animeTraitRuntime.profile,
            variation: Number(this.animeTraitRuntime.variation.toFixed(3)),
            novelty_base: Number(this.animeTraitRuntime.noveltyBase.toFixed(3))
        };
    }

    private formatCloudRoutingRuntime(): string {
        return `mode=${this.llmCloudRuntimeMode}, enabled=${this.slowPathCloudEnabled}, always=${this.slowPathCloudAlways}, complexOnly=${this.slowPathCloudComplexOnly}, allowRandom=${this.slowPathCloudAllowRandom}, probability=${this.slowPathCloudProbability.toFixed(2)}, key=${TA.hasCloudKey() ? 'yes' : 'no'}`;
    }

    private recordLlmProvider(provider: LlmProviderName): void {
        if (!Object.prototype.hasOwnProperty.call(this.metrics.llmProviderStats, provider)) return;
        this.metrics.llmProviderStats[provider] += 1;
    }

    private buildImmediateCommandResponse(input: RawStreamInput, session: SessionState, text: string, turnStartedAt: number): any {
        this.pushSessionMessage(session, input.content || '', 'user');
        this.pushSessionMessage(session, text, 'assistant');
        const totalDurationMs = Date.now() - turnStartedAt;
        this.metrics.recordTurnLatency('fast', totalDurationMs);
        this.recordLlmProvider('none');
        return {
            type: 'response',
            success: true,
            requestId: input.requestId,
            text,
            audioPath: null,
            llmProvider: 'none',
            policy: ['creator_runtime_command'],
            soul: this.lastSoulState,
            emotion: 'neutral',
            metadata: {
                decisionTime: totalDurationMs,
                generationTime: 0,
                totalTime: totalDurationMs,
                fallbackUsed: false,
                route: 'fast',
                routeReason: 'creator_runtime_command',
                llmProvider: 'none',
                llmCloudRuntimeMode: this.llmCloudRuntimeMode,
                moduleLevel: 'minimal',
                complexity: 0,
                confidence: 1,
                stageDurations: {}
            }
        };
    }

    private tryHandleCreatorLlmCommand(input: RawStreamInput): string | null {
        if (!TA.isCreatorSession(input)) return null;
        const text = (input.content || '').trim();
        if (!text.startsWith('/llm')) return null;

        const parts = text.split(/\s+/).map((part) => part.trim()).filter(Boolean);
        const second = (parts[1] || '').toLowerCase();
        const third = (parts[2] || '').toLowerCase();

        if (parts.length === 1 || second === 'status' || second === '状态') {
            return `当前 LLM 云路由状态：${this.formatCloudRoutingRuntime()}。`;
        }

        const setMode = (mode: CloudRuntimeMode): string => {
            this.llmCloudRuntimeMode = mode;
            return `已更新 LLM 云路由模式为 ${mode}。${this.formatCloudRoutingRuntime()}。`;
        };

        if (second === 'cloud' || second === '云') {
            if (!third || third === 'status' || third === '状态') {
                return `当前 LLM 云路由状态：${this.formatCloudRoutingRuntime()}。`;
            }
            if (third === 'on' || third === '开启') return setMode('on');
            if (third === 'off' || third === '关闭') return setMode('off');
            if (third === 'auto' || third === '自动') return setMode('auto');
            return 'cloud 参数无效。用法：/llm cloud on|off|auto|status';
        }

        if (second === 'on' || second === '开启') return setMode('on');
        if (second === 'off' || second === '关闭') return setMode('off');
        if (second === 'auto' || second === '自动') return setMode('auto');

        return '命令无法识别。用法：/llm status | /llm cloud on|off|auto|status';
    }

    private tryHandleCreatorTraitCommand(input: RawStreamInput): string | null {
        if (!TA.isCreatorSession(input)) return null;
        const text = (input.content || '').trim();
        if (!text.startsWith('/trait')) return null;

        const parts = text.split(/\s+/).map((part) => part.trim()).filter(Boolean);
        const second = (parts[1] || '').toLowerCase();

        if (parts.length === 1 || second === 'status' || second === '状态') {
            return `已读取当前二次元特化参数：${this.formatAnimeTraitRuntime()}。`;
        }

        if (second === 'list' || second === 'profiles' || second === '档位') {
            return `可用特化档位：${this.animeTraitProfiles.join(', ')}。当前：${this.animeTraitRuntime.profile}。`;
        }

        if (second === 'reset' || second === '默认') {
            this.animeTraitRuntime = { ...this.animeTraitDefault };
            return `已恢复默认特化参数：${this.formatAnimeTraitRuntime()}。`;
        }

        if (second === 'on' || second === 'enable' || second === '开启') {
            this.animeTraitRuntime.enabled = true;
            return `已开启 Trait 模式：${this.formatAnimeTraitRuntime()}。`;
        }

        if (second === 'off' || second === 'disable' || second === '关闭') {
            this.animeTraitRuntime.enabled = false;
            return `已关闭 Trait 模式：${this.formatAnimeTraitRuntime()}。`;
        }

        const setProfile = (candidate: string): string | null => {
            const normalizedCandidate = (candidate || '').trim().toLowerCase();
            if (!this.isAnimeTraitProfile(normalizedCandidate as AnimeTraitProfile)) {
                return null;
            }
            this.animeTraitRuntime.profile = normalizedCandidate as AnimeTraitProfile;
            return `已切换特化档位到 ${normalizedCandidate}。当前参数：${this.formatAnimeTraitRuntime()}。`;
        };

        if (second === 'profile' || second === '模式' || second === '档位') {
            const profileAck = setProfile(parts[2] || '');
            if (profileAck) return profileAck;
            return `档位无效。可用档位：${this.animeTraitProfiles.join(', ')}。`;
        }

        const parse01 = (raw: string): number | null => {
            const value = Number.parseFloat((raw || '').trim());
            if (!Number.isFinite(value)) return null;
            if (value < 0 || value > 1) return null;
            return Number(value.toFixed(3));
        };

        if (second === 'variation' || second === '变异度') {
            const parsed = parse01(parts[2] || '');
            if (parsed === null) {
                return 'variation 需要 0 到 1 之间的小数，例如 /trait variation 0.35。';
            }
            this.animeTraitRuntime.variation = parsed;
            return `已更新 variation=${parsed.toFixed(2)}。当前参数：${this.formatAnimeTraitRuntime()}。`;
        }

        if (second === 'novelty' || second === 'novelty_base' || second === '新颖度') {
            const parsed = parse01(parts[2] || '');
            if (parsed === null) {
                return 'novelty 需要 0 到 1 之间的小数，例如 /trait novelty 0.42。';
            }
            this.animeTraitRuntime.noveltyBase = parsed;
            return `已更新 novelty=${parsed.toFixed(2)}。当前参数：${this.formatAnimeTraitRuntime()}。`;
        }

        const directProfileAck = setProfile(second);
        if (directProfileAck) return directProfileAck;

        const usage = '/trait status | /trait list | /trait <profile> | /trait variation <0-1> | /trait novelty <0-1> | /trait on|off | /trait reset';
        return `命令无法识别。用法：${usage}`;
    }

    private formatCreatorEvalChatReport(results: CreatorEvalChatCaseResult[]): string {
        const total = results.length;
        const passed = results.filter((item) => item.score >= 80).length;
        const fallbackHits = results.filter((item) => item.issues.includes('fallback_reply')).length;
        const avgScore = total > 0
            ? results.reduce((acc, item) => acc + item.score, 0) / total
            : 0;
        const p95 = TA.percentileMs(results.map((item) => item.latencyMs), 0.95);
        const worstCases = [...results]
            .sort((a, b) => a.score - b.score || b.latencyMs - a.latencyMs)
            .slice(0, 3);

        const lines = [
            `/eval chat 已完成：通过 ${passed}/${total}，平均分 ${avgScore.toFixed(1)}，P95=${p95}ms，fallback=${fallbackHits}。`
        ];
        for (const row of worstCases) {
            const issue = row.issues.length > 0 ? row.issues.join('|') : 'none';
            lines.push(`- ${row.id}: score=${row.score} route=${row.route} latency=${row.latencyMs}ms issues=${issue} preview="${row.preview}"`);
        }
        return lines.join('\n');
    }

    private async runCreatorEvalChat(): Promise<string> {
        const evalCases = TA.buildCreatorEvalChatCases();
        const results: CreatorEvalChatCaseResult[] = [];

        for (const testCase of evalCases) {
            const caseInput: RawStreamInput = {
                content: testCase.prompt,
                source: 'danmaku',
                userId: '__eval_bot__',
                userName: 'eval_bot',
                requestId: `eval_${Date.now()}_${Math.random().toString(16).slice(2)}`,
                routeHint: testCase.routeHint,
                processingMode: 'background',
                features: {
                    intensity: 0.3,
                    sentiment_hint: 0,
                    timestamp: Date.now()
                }
            };

            const startedAt = Date.now();
            let response: any;
            try {
                response = await this.chat(caseInput);
            } catch (error: any) {
                response = {
                    success: false,
                    text: '',
                    metadata: { route: 'error' },
                    error: error?.message || String(error)
                };
            }
            const latencyMs = Date.now() - startedAt;
            results.push(TA.scoreCreatorEvalChatCase(testCase, response, latencyMs));
        }

        const total = results.length;
        const passed = results.filter((item) => item.score >= 80).length;
        const fallbackHits = results.filter((item) => item.issues.includes('fallback_reply')).length;
        const avgScore = total > 0
            ? results.reduce((acc, item) => acc + item.score, 0) / total
            : 0;
        const passRate = total > 0 ? passed / total : 0;
        const p95 = TA.percentileMs(results.map((item) => item.latencyMs), 0.95);

        this.metrics.evalChatStats.runs += 1;
        this.metrics.evalChatStats.totalCases += total;
        this.metrics.evalChatStats.passedCases += passed;
        this.metrics.evalChatStats.fallbackHits += fallbackHits;
        this.metrics.evalChatStats.lastRunAt = Date.now();
        this.metrics.evalChatStats.lastAvgScore = avgScore;
        this.metrics.evalChatStats.lastPassRate = passRate;
        this.metrics.evalChatStats.lastP95LatencyMs = p95;

        return this.formatCreatorEvalChatReport(results);
    }

    private async tryHandleCreatorEvalCommand(input: RawStreamInput): Promise<string | null> {
        if (!TA.isCreatorSession(input)) return null;
        const text = (input.content || '').trim();
        if (!text.startsWith('/eval')) return null;

        const parts = text.split(/\s+/).map((part) => part.trim()).filter(Boolean);
        const second = (parts[1] || 'chat').toLowerCase();

        if (second === 'status' || second === 'stats' || second === '状态') {
            return this.formatCreatorEvalChatStatus();
        }
        if (second === 'chat' || second === '瀵硅瘽' || parts.length === 1) {
            if (this.metrics.evalChatInFlight) {
                return '已有 /eval chat 正在运行，请稍后再试。';
            }
            this.metrics.evalChatInFlight = true;
            try {
                return await this.runCreatorEvalChat();
            } finally {
                this.metrics.evalChatInFlight = false;
            }
        }
        return '命令无法识别。用法：/eval chat | /eval status';
    }

    private isWithinTtsWarmupWindow(): boolean {
        return Date.now() - this.ttsWarmupStart < this.ttsWarmupWindowMs;
    }

    /**
     * ?????? (React) - ?????????
     */
    public perceive(input: RawStreamInput) {
        this.stimulus$.next(input);
    }

    /**
     * ?????????
     */
    private initializeCognitiveStream() {
        const consciousness$ = this.stimulus$.pipe(
            map(data => ({ type: 'stimulus', data } as CognitiveEvent)),
            // ????????????
            // 鎻愬崌骞跺彂鍒?2锛屽吋椤惧悶鍚愪笌椤哄簭
            mergeMap(event => this.processCognitiveEvent(event), 2),
            tap(result => this.emit('thought', result)),
            share()
        );
        consciousness$.subscribe({
            next: (result) => {
                if (result) {
                    this.output$.next(result);
                }
            },
            error: (err) => console.error('[CognitiveStream] stream error:', err)
        });
    }

    /**
     * ????????? (??????????????
     */
    private async processCognitiveEvent(event: CognitiveEvent): Promise<any> {
        try {
            if (event.type === 'stimulus') {
                return await this.reactToStimulus(event.data);
            }
        } catch (error: any) {
            console.error(`[CognitiveEvent] processing failed: ${error.message}`);
            return null;
        }
    }

    /**
     * ?????? (React) - ?????????
     */
    private async reactToStimulus(input: RawStreamInput): Promise<any> {
        const turnStartedAt = Date.now();
        const stageDurations: Record<string, number> = {};
        const markStage = (name: string, stageStartedAt: number): void => {
            const durationMs = Date.now() - stageStartedAt;
            stageDurations[name] = durationMs;
            this.metrics.recordStageLatency(name, durationMs);
        };

        const snapshot = this.resourceGuard.getSnapshot();
        const overloaded = this.resourceGuard.isOverloaded();
        const routeLocked = input.routeHint === 'fast' || input.routeHint === 'slow';
        let route: ResponseRoute = this.decideInitialRoute(input);
        let routeReason = this.inferRouteReason(input, route, 'initial');
        const routeAnalysis = TA.analyzeInputComplexity(input.content || '', this.fastPathMaxChars, this.fastPathHardMaxChars);
        const moduleLevel = this.decideModuleParticipationLevel(route, routeAnalysis, overloaded, input.content || '');
        const simpleFastPath = route === 'fast' && routeAnalysis.complexity <= this.fastPathSimpleComplexityThreshold;
        const forceFull = moduleLevel === 'full' && !overloaded;
        const skipBrainnn = !forceFull && (moduleLevel === 'minimal' || (route === 'fast' && this.fastPathSkipBrainnn) || (overloaded && this.degradedSkipBrainnn));
        const skipOptional = !forceFull && (moduleLevel === 'minimal' || simpleFastPath || (route === 'fast' && this.fastPathSkipOptional) || (overloaded && this.degradedSkipOptional));
        const skipTts = !this.inlineTtsEnabled || (overloaded && this.degradedSkipTts) || input.processingMode === 'background';
        this.metrics.moduleLevelStats[moduleLevel] += 1;
        const backgroundMode = input.processingMode === 'background';
        const session = this.getOrCreateSession(input);
        this.syncSessionWithCanonical(session);
        const resumed = this.detectSessionResume(session);
        if (resumed) {
            console.log(`[Session] resume_detected user=${session.key} reconnect_count=${session.reconnectCount}`);
        }
        const evalCommandReply = await this.tryHandleCreatorEvalCommand(input);
        if (evalCommandReply) {
            return this.buildImmediateCommandResponse(input, session, evalCommandReply, turnStartedAt);
        }
        const llmCommandReply = this.tryHandleCreatorLlmCommand(input);
        if (llmCommandReply) {
            return this.buildImmediateCommandResponse(input, session, llmCommandReply, turnStartedAt);
        }
        const traitCommandReply = this.tryHandleCreatorTraitCommand(input);
        if (traitCommandReply) {
            return this.buildImmediateCommandResponse(input, session, traitCommandReply, turnStartedAt);
        }
        this.applySessionUpdate(session, this.extractSessionUpdate(input), input);
        this.pushSessionMessage(session, input.content || '', 'user');
        TA.updateTopicTracking(session, input.content || '');
        TA.updateSessionPhase(session, input.content || '');

        let stageServiceTimeoutMs = this.getServiceTimeout(route);

        if (overloaded) {
            console.warn(`[ResourceGuard] High load: CPU ${snapshot.cpuUsage.toFixed(1)}%, MEM ${snapshot.memUsage.toFixed(1)}%`);
        }

        // 0) Memory retrieval: run in parallel with BrainNN for lower foreground latency
        let memoryContext: MemoryContext | null = null;
        const canUseMemory = this.memoryEnabled && !skipOptional;
        const deferMemory = route === 'fast' && this.fastPathSkipMemory;
        const retrievalTopK = route === 'fast' ? 4 : 8;
        const memoryPromise = (canUseMemory && !deferMemory)
            ? (async (): Promise<MemoryContext | null> => {
                const stageStartedAt = Date.now();
                try {
                    const context = await this.withSoftTimeout<MemoryContext | null>(
                        'memory_retrieve',
                        async () => this.memoryRetriever.retrieve(
                            input.content,
                            input.userId,
                            { topK: retrievalTopK, includeUserProfile: true, requestId: input.requestId }
                        ),
                        stageServiceTimeoutMs,
                        null
                    );

                    const uid = input.userId;
                    if (context && uid) {
                        const emotionalHistory = await this.withSoftTimeout<any>(
                            'memory_emotion_history',
                            async () => this.memoryRetriever.retrieveEmotionalHistory(
                                uid,
                                'negative',
                                60 * 60 * 1000
                            ),
                            Math.min(stageServiceTimeoutMs, 1200),
                            { count: 0 }
                        );
                        if ((emotionalHistory?.count || 0) >= 3) {
                            console.log('[Memory] negative-emotion pattern detected');
                        }
                    }
                    return context;
                } catch (error: any) {
                    console.error(`[Memory] retrieve error: ${error.message}`);
                    return null;
                } finally {
                    markStage('memory_retrieve', stageStartedAt);
                }
            })()
            : Promise.resolve(null);

        // 1) BrainNN signal
        const signalPromise = (async (): Promise<BrainSignal> => {
            const stageStartedAt = Date.now();
            let resolvedSignal: BrainSignal = this.buildDefaultSignal(input);
            if (!skipBrainnn) {
                resolvedSignal = await this.withSoftTimeout<BrainSignal>(
                    'brainnn_think',
                    async () => {
                        const response = await axios.post(
                            `${this.brainEndpoint}/think`,
                            {
                                text: input.content,
                                source: input.source,
                                trait_runtime: this.buildAnimeTraitRuntimePayload()
                            },
                            { timeout: stageServiceTimeoutMs }
                        );
                        return response.data as BrainSignal;
                    },
                    stageServiceTimeoutMs,
                    resolvedSignal
                );
            }
            markStage('brainnn', stageStartedAt);
            return resolvedSignal;
        })();

        const [resolvedMemoryContext, resolvedSignal] = await Promise.all([memoryPromise, signalPromise]);
        memoryContext = resolvedMemoryContext;
        let signal: BrainSignal = resolvedSignal;

        // 2. 记录状态
        if (signal.soul) this.lastSoulState = signal.soul as unknown as SoulState;

        // 3) Neuro-symbolic + Agent Core (内联)
        let neuroSymbolicResult: any = null;
        let agentAnalysis: any = null;
        if (!skipOptional) {
            const stageStartedAt = Date.now();
            try {
                neuroSymbolicResult = this.inlineRuleEngine.checkContent(input.content || '');
                neuroSymbolicResult.action = neuroSymbolicResult.isSensitive ? 'filter' : 'pass';
                neuroSymbolicResult.suggestion = neuroSymbolicResult.isSensitive ? '内容包含敏感词' : null;
            } catch (error: any) {
                console.error(`[NeuroSymbolic] ${error.message}`);
            } finally {
                markStage('neuro_symbolic', stageStartedAt);
            }

            if (!(route === 'fast' && this.fastPathSkipAgentCore)) {
                const agentStartedAt = Date.now();
                try {
                    agentAnalysis = this.inlineAgentCore.analyzeSituation(signal.soul, {
                        text: input.content,
                        source: input.source
                    });
                } catch (error: any) {
                    console.error(`[AgentCore] ${error.message}`);
                } finally {
                    markStage('agent_core', agentStartedAt);
                }
            }

            if (neuroSymbolicResult && !routeLocked) {
                const before = route;
                if (neuroSymbolicResult.isGreeting) {
                    route = 'fast';
                }
                if (route !== before) {
                    routeReason = this.inferRouteReason(input, route, 'rule');
                    stageServiceTimeoutMs = this.getServiceTimeout(route);
                }
            }

            if (neuroSymbolicResult && neuroSymbolicResult.action === 'filter') {
                const totalDurationMs = Date.now() - turnStartedAt;
                this.metrics.recordTurnLatency(route, totalDurationMs);
                this.recordLlmProvider('none');
                let blockedText = neuroSymbolicResult.suggestion || this.errorPhrase;
                const safeName = this.getAddressableName(session, input);
                const sanitized = this.sanitizeUnsafePublicIdsInReply(blockedText, input, safeName);
                if (sanitized.changed) {
                    blockedText = sanitized.text;
                }
                return {
                    type: 'response',
                    success: true,
                    requestId: input.requestId,
                    text: blockedText,
                    audioPath: null,
                    llmProvider: 'none',
                    policy: ['filtered'],
                    soul: signal.soul,
                    emotion: TA.getDominantEmotion(signal.soul),
                    ruleBlocked: true,
                    ruleReason: neuroSymbolicResult.warnings?.join(', '),
                    metadata: {
                        decisionTime: totalDurationMs,
                        generationTime: 0,
                        totalTime: totalDurationMs,
                        route,
                        routeReason,
                        llmProvider: 'none',
                        llmCloudRuntimeMode: this.llmCloudRuntimeMode,
                        moduleLevel,
                        complexity: Number(routeAnalysis.complexity.toFixed(3)),
                        confidence: Number(routeAnalysis.confidence.toFixed(3)),
                        stageDurations
                    }
                };
            }
        }

        // 4. ??????????????LLM??
        let moodInstruction = signal.mood_instruction || '';
        if (!moodInstruction && signal.soul) {
            const joy = signal.soul.emotion?.['joy'] ?? 0;
            const sadness = signal.soul.emotion?.['sadness'] ?? 0;
            const anger = signal.soul.emotion?.['anger'] ?? 0;
            const boredom = signal.soul.drives?.['boredom'] ?? 0;
            const socialNeed = signal.soul.drives?.['social_need'] ?? 0;

            if (joy > 0.5) moodInstruction = '??????????????';
            else if (sadness > 0.7) moodInstruction = '??????????????';
            else if (anger > 0.7) moodInstruction = '??????????????';
            else if (boredom > 0.7) moodInstruction = '?????????';
            else if (socialNeed > 0.8) moodInstruction = '?????????';
            else moodInstruction = '?????????';
        }

        if (route === 'slow' && !memoryContext && canUseMemory) {
            const stageStartedAt = Date.now();
            memoryContext = await this.withSoftTimeout<MemoryContext | null>(
                'memory_slow_retry',
                async () => this.memoryRetriever.retrieve(
                    input.content,
                    input.userId,
                    { topK: 8, includeUserProfile: true, requestId: input.requestId }
                ),
                this.optionalServiceTimeoutMs,
                null
            );
            markStage('memory_slow_retry', stageStartedAt);
        }

        session.viewerTier = this.inferViewerTier(session, memoryContext);
        this.metrics.recordViewerTier(session.viewerTier);
        this.metrics.recordRoute(route, routeReason);
        const bypassTools = simpleFastPath || skipOptional;
        const toolShadowDecision: ToolShadowDecision = bypassTools
            ? { needed: false, reason: simpleFastPath ? 'fast_simple_bypass' : 'optional_skipped', tools: [] }
            : this.detectToolShadow(input, route);
        const toolsStartedAt = Date.now();
        const toolExecutionResult: ToolExecutionResult = bypassTools
            ? { mode: 'shadow', triggered: false, reason: toolShadowDecision.reason, calls: [] }
            : await this.executeToolsIfNeeded(input, route, toolShadowDecision);
        markStage('tool_execution', toolsStartedAt);
        const toolShadowContext = this.buildToolExecutionContext(toolShadowDecision, toolExecutionResult);
        if (toolShadowDecision.needed) {
            console.log(`[ToolShadow] rid=${input.requestId || 'na'} reason=${toolShadowDecision.reason} tools=${toolShadowDecision.tools.join('|')}`);
        }
        if (toolExecutionResult.triggered && toolExecutionResult.mode === 'live') {
            const toolSummary = toolExecutionResult.calls
                .map((call) => `${call.toolId}:${call.status}`)
                .join(',');
            console.log(`[ToolExec] rid=${input.requestId || 'na'} reason=${toolExecutionResult.reason} selected=${toolExecutionResult.selectedTool || 'none'} calls=${toolSummary || 'none'}`);
        }

        // 5. ??? LLM ??????
        const llmStartedAt = Date.now();
        const polished = await this.polishResponse(input.content, toolShadowContext, input, signal, memoryContext, route, agentAnalysis, session);
        let finalOutput = polished.text;
        const llmProvider: LlmProviderName = polished.provider || 'unknown';
        this.recordLlmProvider(llmProvider);
        markStage('llm', llmStartedAt);
        finalOutput = TA.stripTemplateNoise(finalOutput);

        // 4.5 本地风险评估（替代外部 Prediction Engine）
        let predictionAdjusted = false;
        if (this.predictionEnabled && !skipOptional) {
            // 简单的本地内容检查
            const blockedPatterns = [
                /我不知道/gi,
                /浣滀负AI/gi,
                /我无法/gi,
            ];
            
            for (const pattern of blockedPatterns) {
                if (pattern.test(finalOutput)) {
                    console.warn(`[Prediction] 本地检查：发现潜在问题模式`);
                    predictionAdjusted = false;
                    break;
                }
            }
        }

        const persistMemorySystem = async (): Promise<void> => {
            try {
                // 浣跨敤鍐呯疆璁板繂绯荤粺鏇夸唬澶栭儴鏈嶅姟
                await this.mem0.add(input.content || '', finalOutput, input.userId || 'anonymous');
            } catch (error: any) {
                console.error(`[MemorySystem] ${error.message}`);
            }
        };

        const persistVectorStore = async (): Promise<void> => {
            try {
                const memoryRecord = await this.memoryEncoder.encode({
                    input,
                    response: finalOutput,
                    signal
                });
                await this.addOrUpdateMemory(memoryRecord, input.userId);
            } catch (error: any) {
                console.error(`[Memory Encoding] ${error.message}`);
            }
        };

        // 7/8) non-critical persistence can be detached to keep foreground latency low
        if (!skipOptional && !backgroundMode) {
            if (this.asyncPersistenceEnabled) {
                TA.runDetached('memory_system_store', persistMemorySystem);
            } else {
                const stageStartedAt = Date.now();
                await persistMemorySystem();
                markStage('memory_system_store', stageStartedAt);
            }
        }

        if (this.memoryEnabled && !skipOptional && !backgroundMode) {
            if (this.asyncPersistenceEnabled) {
                TA.runDetached('vector_store_add', persistVectorStore);
            } else {
                const stageStartedAt = Date.now();
                await persistVectorStore();
                markStage('vector_store_add', stageStartedAt);
            }
        }

        if (predictionAdjusted) {
            const guardedFinal = this.enforceConsistencyGuard(finalOutput, input, route, session);
            this.metrics.logConsistencyStats(guardedFinal.flags, input);
            finalOutput = guardedFinal.text;
        }

        const goalDriven = this.applyGoalDriver(finalOutput, input, session);
        if (goalDriven.nudged) {
            const guardedGoal = this.enforceConsistencyGuard(goalDriven.text, input, route, session);
            this.metrics.logConsistencyStats(guardedGoal.flags, input);
            finalOutput = guardedGoal.text;
            console.log(`[GoalPlanner] rid=${input.requestId || 'na'} nudge_applied turn=${session.turnCount} tier=${session.viewerTier}`);
        }
        const safeName = this.getAddressableName(session, input);
        const sanitizedPublic = this.sanitizeUnsafePublicIdsInReply(finalOutput, input, safeName);
        if (sanitizedPublic.changed) {
            finalOutput = sanitizedPublic.text;
        }
        if (!TA.isMeaningfulText(finalOutput)) {
            finalOutput = this.buildRescueReply(input.content || '');
        }

        this.pushSessionMessage(session, finalOutput, 'assistant');
        TA.updateTopicTracking(session, input.content || '', finalOutput);
        TA.completeLatestGoalIfNeeded(session, finalOutput);
        TA.updateSessionPhase(session, input.content || '', finalOutput);
        this.maybeUpdateSessionSummary(session, input.requestId);

        // 9. ?????????
        const dominantEmotion = TA.getDominantEmotion(signal.soul);
        const voiceParams = generateVoiceParams(signal.soul, dominantEmotion);

        // 10. ??? TTS ??????
        let audioPath = null;
        const isWarmupReply = finalOutput === this.warmupPhrase;
        if (!skipTts && !isWarmupReply) {
            const ttsStartedAt = Date.now();
            try {
                const ttsResult = await runWithTTSCircuitBreaker(async () =>
                    this.withSoftTimeout<any>(
                        'inline_tts',
                        async () => axios.post(`${this.ttsEndpoint}/api/tts`, {
                            text: finalOutput,
                            language: process.env.TTS_LANGUAGE || 'zh-CN',
                            voice_id: parseInt(process.env.TTS_VOICE_ID || '1'),
                            emotion: voiceParams.emotion || 'neutral',
                            speech_rate: voiceParams.speech_rate || 1.0,
                            pitch: voiceParams.pitch || 0
                        }, { timeout: this.inlineTtsTimeoutMs }),
                        this.inlineTtsTimeoutMs,
                        null
                    )
                );
                if (isFallbackResponse(ttsResult)) {
                    console.error('[TTS] circuit open or repeated failure, skipping synthesis');
                } else {
                    const ttsResponse = ttsResult as { data?: { audio_url?: string; audioPath?: string; path?: string } };
                    audioPath = ttsResponse?.data?.audio_url || ttsResponse?.data?.audioPath || ttsResponse?.data?.path || null;
                }
            } catch (error: any) {
                if (this.isWithinTtsWarmupWindow() && TA.isTtsWarmupError(error)) {
                    if (!this.ttsWarmupLogged) {
                        console.log('[TTS] Warming up. Audio will be available shortly.');
                        this.ttsWarmupLogged = true;
                    }
                } else {
                    console.error(`[TTS] inline synthesis failed: ${error.message}`);
                }
            } finally {
                markStage('inline_tts', ttsStartedAt);
            }
        }

        const totalDurationMs = Date.now() - turnStartedAt;
        this.metrics.recordTurnLatency(route, totalDurationMs);
        const generationTime = stageDurations.llm || 0;
        const decisionTime = Math.max(0, totalDurationMs - generationTime);

        return {
            type: 'response',
            success: true,
            requestId: input.requestId,
            text: finalOutput,
            audioPath: audioPath,
            llmProvider,
            policy: signal.policy,
            soul: signal.soul,
            emotion: dominantEmotion,
            voiceParams,
            memoryContext: memoryContext?.summary || null,
            prediction: null,
            toolShadow: toolShadowDecision,
            toolExecution: toolExecutionResult,
            metadata: {
                decisionTime,
                generationTime,
                totalTime: totalDurationMs,
                fallbackUsed: false,
                route,
                routeReason,
                llmProvider,
                llmCloudRuntimeMode: this.llmCloudRuntimeMode,
                moduleLevel,
                complexity: Number(routeAnalysis.complexity.toFixed(3)),
                confidence: Number(routeAnalysis.confidence.toFixed(3)),
                stageDurations
            }
        };
    }

    /**
     * ?????(Adapter) - ???????????
     */
    async chat(input: RawStreamInput): Promise<any> {
        const requestId = this.ensureRequestId(input);
        this.perceive(input);
        return new Promise(resolve => {
            const timeoutRaw =
                process.env.CHAT_RESPONSE_TIMEOUT_MS ||
                process.env.LLM_TIMEOUT_MS ||
                '25000';
            const timeoutMs = Number.parseInt(timeoutRaw, 10);
            const safeTimeoutMs = Number.isNaN(timeoutMs) ? 25000 : timeoutMs;

            let sub: any;
            const timer = setTimeout(() => {
                if (sub) sub.unsubscribe();
                resolve({
                    type: 'response',
                    success: true,
                    requestId,
                    text: this.errorPhrase,
                    audioPath: null,
                    llmProvider: 'unknown',
                    policy: [],
                    soul: this.lastSoulState,
                    emotion: 'neutral',
                    voiceParams: generateVoiceParams(this.lastSoulState, 'neutral')
                });
            }, safeTimeoutMs);

            sub = this.output$.pipe(
                filter(x => x.type === 'response' && (x.requestId ? x.requestId === requestId : true))
            ).subscribe(res => {
                clearTimeout(timer);
                sub.unsubscribe();
                resolve(res);
            });
        });
    }

    /**
     * LLM ??? - ??? DeepSeek API (Neuro-Symbolic ???)
     * V7 ??? BrainNN ??mood_instruction
     * Phase 2: ???????
     * Phase 3: ?????????
     */

    /**
     * Phase 2: SSE Streaming Chat
     * Directly processes input and yields tokens via local/cloud LLM stream.
     * Replicates the cognitive pipeline of reactToStimulus.
     */
    async *chatStream(input: RawStreamInput): AsyncGenerator<string> {
        this.perceive(input);
        const turnStartedAt = Date.now();
        const stageDurations: Record<string, number> = {};
        const markStage = (name: string, start: number) => {
            const durationMs = Date.now() - start;
            stageDurations[name] = durationMs;
            this.metrics.recordStageLatency(name, durationMs);
        };

        const snapshot = this.resourceGuard.getSnapshot();
        const overloaded = this.resourceGuard.isOverloaded();
        // const routeLocked = input.routeHint === 'fast' || input.routeHint === 'slow'; // unused in simplified flow
        let route: ResponseRoute = this.decideInitialRoute(input);
        // let routeReason = this.inferRouteReason(input, route, 'initial'); // unused
        const routeAnalysis = TA.analyzeInputComplexity(input.content || '', this.fastPathMaxChars, this.fastPathHardMaxChars);
        const moduleLevel = this.decideModuleParticipationLevel(route, routeAnalysis, overloaded, input.content || '');
        const simpleFastPath = route === 'fast' && routeAnalysis.complexity <= this.fastPathSimpleComplexityThreshold;
        const forceFull = moduleLevel === 'full' && !overloaded;
        const skipBrainnn = !forceFull && (moduleLevel === 'minimal' || (route === 'fast' && this.fastPathSkipBrainnn) || (overloaded && this.degradedSkipBrainnn));
        const skipOptional = !forceFull && (moduleLevel === 'minimal' || simpleFastPath || (route === 'fast' && this.fastPathSkipOptional) || (overloaded && this.degradedSkipOptional));

        this.metrics.moduleLevelStats[moduleLevel] += 1;
        const session = this.getOrCreateSession(input);
        this.syncSessionWithCanonical(session);

        // Command Handling (Immediate Return)
        const evalCommandReply = await this.tryHandleCreatorEvalCommand(input);
        if (evalCommandReply) {
            const resp = this.buildImmediateCommandResponse(input, session, evalCommandReply, turnStartedAt);
            yield resp.text;
            return;
        }
        const llmCommandReply = this.tryHandleCreatorLlmCommand(input);
        if (llmCommandReply) {
            const resp = this.buildImmediateCommandResponse(input, session, llmCommandReply, turnStartedAt);
            yield resp.text;
            return;
        }
        const traitCommandReply = this.tryHandleCreatorTraitCommand(input);
        if (traitCommandReply) {
            const resp = this.buildImmediateCommandResponse(input, session, traitCommandReply, turnStartedAt);
            yield resp.text;
            return;
        }

        this.applySessionUpdate(session, this.extractSessionUpdate(input), input);
        this.pushSessionMessage(session, input.content || '', 'user');
        TA.updateSessionPhase(session, input.content || '');

        let stageServiceTimeoutMs = this.getServiceTimeout(route);

        // 0) Memory retrieval
        let memoryContext: MemoryContext | null = null;
        const canUseMemory = this.memoryEnabled && !skipOptional;
        const deferMemory = route === 'fast' && this.fastPathSkipMemory;
        const retrievalTopK = route === 'fast' ? 4 : 8;
        const memoryPromise = (canUseMemory && !deferMemory)
            ? (async (): Promise<MemoryContext | null> => {
                const stageStartedAt = Date.now();
                try {
                    return await this.withSoftTimeout<MemoryContext | null>(
                        'memory_retrieve',
                        async () => this.memoryRetriever.retrieve(
                            input.content,
                            input.userId,
                            { topK: retrievalTopK, includeUserProfile: true, requestId: input.requestId }
                        ),
                        stageServiceTimeoutMs,
                        null
                    );
                } catch (error: any) {
                    console.error(`[Memory] retrieve error: ${error.message}`);
                    return null;
                } finally {
                    markStage('memory_retrieve', stageStartedAt);
                }
            })()
            : Promise.resolve(null);

        // 1) BrainNN signal
        const signalPromise = (async (): Promise<BrainSignal> => {
            const stageStartedAt = Date.now();
            let resolvedSignal: BrainSignal = this.buildDefaultSignal(input);
            if (!skipBrainnn) {
                resolvedSignal = await this.withSoftTimeout<BrainSignal>(
                    'brainnn_think',
                    async () => {
                        const response = await axios.post(
                            `${this.brainEndpoint}/think`,
                            {
                                text: input.content,
                                source: input.source,
                                trait_runtime: this.buildAnimeTraitRuntimePayload()
                            },
                            { timeout: stageServiceTimeoutMs }
                        );
                        return response.data as BrainSignal;
                    },
                    stageServiceTimeoutMs,
                    resolvedSignal
                );
            }
            markStage('brainnn', stageStartedAt);
            return resolvedSignal;
        })();

        const [resolvedMemoryContext, resolvedSignal] = await Promise.all([memoryPromise, signalPromise]);
        memoryContext = resolvedMemoryContext;
        let signal: BrainSignal = resolvedSignal;

        if (signal.soul) this.lastSoulState = signal.soul as unknown as SoulState;

        // 3) Agent Analysis (内联)
        let agentAnalysis: any = null;
        if (!skipOptional && !(route === 'fast' && this.fastPathSkipAgentCore)) {
            const stageStartedAt = Date.now();
            try {
                agentAnalysis = this.inlineAgentCore.analyzeSituation(signal.soul, {
                    text: input.content,
                    source: input.source
                });
            } catch (error: any) {
                console.error('[AgentCore] Error:', error.message);
            } finally {
                markStage('agent_core', stageStartedAt);
            }
        }

        // 4) Tools
        session.viewerTier = this.inferViewerTier(session, memoryContext);
        const bypassTools = simpleFastPath || skipOptional;
        const toolShadowDecision = bypassTools
            ? { needed: false, reason: 'bypass', tools: [] }
            : this.detectToolShadow(input, route);

        let toolContext: string | null = null;
        if (!bypassTools) {
            const toolExecutionResult = await this.executeToolsIfNeeded(input, route, toolShadowDecision as any);
            if (toolExecutionResult.triggered && toolExecutionResult.mode === 'live') {
                toolContext = this.buildToolExecutionContext(toolShadowDecision, toolExecutionResult);
            }
        }

        // 5) Prepare Prompt
        const {
            userContent,
            systemPrompt,
            samplingPlan,
            maxTokens,
            model,
            preferCloud,
            forceProvider,
            strictProvider,
            activeSession,
            isChineseInput,
            strategy
        } = await this.prepareLlmRequest(
            input,
            signal,
            memoryContext,
            route,
            agentAnalysis,
            session,
            toolContext
        );

        // 6) Generate Stream
        const llmHandler = getGlobalLLMFallbackHandler();
        const llmRequestTimeoutMs = this.getLlmRequestTimeoutMs(input, route);
        const stream = llmHandler.generateStream({
            prompt: userContent,
            systemPrompt,
            temperature: samplingPlan.temperature,
            topP: samplingPlan.topP,
            maxTokens,
            model,
            preferCloud,
            forceProvider,
            strictProvider,
            timeout: llmRequestTimeoutMs
        });

        let fullText = '';
        try {
            for await (const chunk of stream) {
                fullText += chunk;
                yield chunk;
            }
        } catch (error: any) {
            console.error(`[Stream] Gen failed: ${error.message}`);
            yield " [Error: Connection lost]";
        }

        const llmProvider = preferCloud ? 'deepseek' : 'local';
        this.recordLlmProvider(llmProvider);
        const totalDurationMs = Date.now() - turnStartedAt;
        this.metrics.recordTurnLatency(route, totalDurationMs);

        // 7) Post-Processing (Simplified)
        const finalOutput = TA.stripTemplateNoise(fullText);

        this.pushSessionMessage(session, finalOutput, 'assistant');
        session.lastAssistantAt = Date.now();
        session.turnCount += 1;

        // Persist Memory
        if (!this.memoryWriteGateEnabled || routeAnalysis.confidence > this.memoryStableWriteMinConfidence) {
            this.persistMemory(input, finalOutput, session).catch(e => console.error(e));
        }
    }

    /**
     * Helper to persist memory after chat/stream
     */
    private async persistMemory(input: RawStreamInput, text: string, session: SessionState) {
        const content = input.content || '';
        const userId = input.userId || 'default';
        
        // MemoryR1 鍐崇瓥
        const decision = this.memoryR1.decide({
            content,
            context: '瀵硅瘽璁板繂',
            importance: this.memoryR1.estimateImportance(content),
            recency: 1.0,
            redundancy: this.memoryR1.estimateRedundancy(content, []),
        });
        
        if (decision.action === 'forget') {
            console.log(`[MemoryR1] 鍐冲畾涓嶅瓨鍌? ${content.slice(0, 30)}...`);
            return;
        }

        const feedback = decision.action === 'store' ? 'success' : 'neutral';
        this.evoMemory.addExperience(
            content,
            text,
            feedback,
            { userId }
        );

        const mem0Facts = await this.mem0.add(content, text, userId);
        
        // 同步到 TransparentMemory
        if (mem0Facts.length > 0) {
            await this.transparentMemory.syncFromMem0(userId, mem0Facts);
        }
    }

    /**
     * Prepares the context and prompt for LLM generation.
     * Shared by polishResponse (standard) and chatStream (streaming).
     */
    private async prepareLlmRequest(
        input: RawStreamInput,
        signal: BrainSignal,
        memoryContext: MemoryContext | null,
        route: ResponseRoute,
        agentAnalysis: any = null,
        session?: SessionState,
        toolContext?: string | null
    ) {
        const soul: any = signal.soul || {};
        const emotion: any = soul.emotion || {};
        const drives: any = soul.drives || {};
        const personality: any = soul.personality || {};
        const activeSession = session || this.getOrCreateSession(input);
        TA.updateTopicTracking(activeSession, input.content);
        const replyLanguage = TA.shouldReplyInChinese(input.content, this.preferChineseByDefault) ? 'Chinese' : 'same as the user';

        let moodInstruction = (signal as any).mood_instruction || soul.mood_instruction || '';

        if (!moodInstruction) {
            if (emotion['joy'] > 0.5) moodInstruction = 'energetic and cheerful';
            else if (emotion['anger'] > 0.3) moodInstruction = 'firm but calm';
            else if (drives['boredom'] > 0.6) moodInstruction = 'proactive and curious';
            else moodInstruction = 'natural and friendly';
        }

        const emotionDetails = Object.entries(emotion)
            .filter(([_, v]) => (v as number) > 0.2)
            .map(([k, v]) => `${k}=${(v as number).toFixed(2)}`)
            .join(', ');

        const contextBudget = this.buildContextBudget(memoryContext, input, route, activeSession);
        let memorySection = route === 'slow' ? contextBudget.section : '';

        const evoExperiences = this.evoMemory.retrieveRelevantExperience(input.content || '', 3);
        const evoContext = this.evoMemory.formatForPrompt(evoExperiences);
        
        const mem0Facts = this.mem0.search(input.content || '', input.userId, 5);
        const mem0Context = this.mem0.formatForPrompt(mem0Facts);
        
        // 视觉分析（静默后台截图，不弹窗）
        let visionContext = '';
        if (this.visionService.needsVisionContext(input.content || '')) {
            try {
                const buffer = await this.visionService.captureScreen();
                const visionResult = await this.visionService.analyzeImage(buffer);
                visionContext = this.visionService.formatForPrompt(visionResult);
                
                await this.visualMemoryStore.store(visionResult, { source: 'auto' });
            } catch (err) {
                console.error('[Vision] Capture/analysis failed:', err);
            }
        }
        
        const visualMemories = this.visualMemoryStore.search(input.content || '', 3);
        const visualMemoryContext = this.visualMemoryStore.formatForPrompt(visualMemories);
        
        const allContexts = [memorySection, evoContext, mem0Context, visionContext, visualMemoryContext].filter(Boolean);
        if (allContexts.length > 0) {
            memorySection = allContexts.join('\n\n');
        }

        let agentSection = '';
        if (agentAnalysis?.analysis) {
            const analysis = agentAnalysis.analysis;
            const reasoning = Array.isArray(analysis.reasoning) ? analysis.reasoning.join('；') : '';
            const goal = analysis.goal || '';
            const planSteps = Array.isArray(agentAnalysis.thinking_state?.plan_steps)
                ? agentAnalysis.thinking_state.plan_steps.join(' -> ')
                : '';
            agentSection = `\n\n[Agent] goal=${goal} plan=${planSteps || 'n/a'} reasoning=${reasoning || 'n/a'}`;
        }

        let personalityHint = '';
        if (personality['agreeableness'] < 0.3) {
            personalityHint = 'Keep boundaries clear.';
        }
        if (personality['neuroticism'] > 0.7) {
            personalityHint += ' Keep tone calm and stable.';
        }

        const maxWords = route === 'fast' ? this.fastReplyMaxWords : this.slowReplyMaxWords;
        const sessionSection = this.buildSessionSection(activeSession);
        const personaGuard = this.buildPersonaGuard(activeSession, replyLanguage);
        const strategy = this.buildDialogueStrategy(input, activeSession, route);
        if (TA.isCreatorSession(input)) {
            this.metrics.groundingStats.creatorTurns += 1;
        }
        let runtimeStateEvidence: RuntimeStateEvidence | null = null;
        if (strategy.requiresStateGrounding) {
            this.metrics.groundingStats.stateQueries += 1;
            runtimeStateEvidence = await this.fetchRuntimeStateEvidence(input.content || '');
            if (runtimeStateEvidence.available) {
                strategy.requiredFacts.push(`runtime_state_evidence=${runtimeStateEvidence.summary}`);
            } else {
                strategy.uncertaintyMode = 'strict';
                strategy.requiredFacts.push('runtime_state_evidence=unavailable');
            }
        }
        const creatorChannelSection = this.buildCreatorChannelSection(input, activeSession);
        const runtimeEvidenceSection = runtimeStateEvidence
            ? `Runtime state evidence: ${runtimeStateEvidence.summary}${runtimeStateEvidence.notes.length > 0 ? `; notes=${runtimeStateEvidence.notes.join('|')}` : ''}`
            : '';
        const systemPrompt = this.buildSystemPrompt(
            route,
            maxWords,
            moodInstruction,
            emotionDetails,
            drives,
            personalityHint,
            memorySection,
            agentSection,
            sessionSection,
            personaGuard,
            replyLanguage,
            signal,
            agentAnalysis,
            strategy
        );

        const isChineseInput = TA.shouldReplyInChinese(input.content, this.preferChineseByDefault);
        const userMessage = this.applyNoThinkDirective(input.content);
        const sessionInputSection = (this.isNeuralPolicyMode() && !this.neuralModeIncludeSessionMemory)
            ? ''
            : (sessionSection || '');
        const userContentBase = isChineseInput
            ? `Please answer in Simplified Chinese. User message: ${userMessage}`
            : `${userMessage}`;
        const userContent = this.buildPromptWithHardLimit(
            userContentBase,
            [
                `Context: ${toolContext || 'none'}`,
                sessionInputSection,
                creatorChannelSection,
                runtimeEvidenceSection,
                `Generation policy:\n${this.renderStrategyAsPrompt(strategy)}`
            ]
        );

        const llmMaxTokens = parseInt(process.env.LLM_MAX_TOKENS || '200', 10);
        const routeMaxTokens = route === 'fast' ? this.fastPathMaxTokens : llmMaxTokens;
        let maxTokens = this.resourceGuard.isOverloaded()
            ? Math.min(routeMaxTokens, this.degradedMaxTokens)
            : routeMaxTokens;
        const realtimeGuard = this.shouldUseRealtimeGuard(input, route);
        if (realtimeGuard) {
            maxTokens = Math.min(maxTokens, route === 'fast' ? this.liveFastMaxTokens : this.liveSlowMaxTokens);
        }
        const samplingPlan = this.buildSamplingPlan(route, input, activeSession, signal);
        const preferCloudByPolicy = this.shouldPreferCloud(route, input);
        const preferCloudByOverload =
            this.llmCloudRuntimeMode !== 'off' &&
            this.preferCloudOnOverload &&
            this.resourceGuard.isOverloaded() &&
            TA.hasCloudKey();
        let preferCloud = preferCloudByPolicy || preferCloudByOverload;
        const localFastForced = this.liveForceLocalFast && this.useLocalLlmEnabled && realtimeGuard && route === 'fast';
        if (localFastForced) {
            preferCloud = false;
        }
        const forceProvider: 'local' | 'deepseek' | undefined = localFastForced
            ? 'local'
            : (preferCloud ? 'deepseek' : undefined);
        if (route === 'slow') {
            const slowReasons: string[] = [];
            if (this.containsComplexIntent(input.content || '')) slowReasons.push('complex_intent');
            if (preferCloudByPolicy) slowReasons.push('cloud_policy');
            if (preferCloudByOverload) slowReasons.push('overload');
            if (slowReasons.length === 0) slowReasons.push('default_slow');
            console.log(`[LLMRoute] route=slow reason=${slowReasons.join('|')} mode=${this.llmCloudRuntimeMode} enabled=${this.slowPathCloudEnabled} complexOnly=${this.slowPathCloudComplexOnly} allowRandom=${this.slowPathCloudAllowRandom} hasKey=${TA.hasCloudKey()} preferCloud=${preferCloud} policy=${preferCloudByPolicy} overload=${preferCloudByOverload} realtimeGuard=${realtimeGuard}`);
        }
        if (localFastForced) {
            console.log(`[LLMRoute] fast live turn forced to local provider (LIVE_FORCE_LOCAL_FAST, strict=${this.liveForceLocalFastStrict}).`);
        }

        const deepseekFastModel = (process.env.DEEPSEEK_FAST_MODEL || '').trim();
        const deepseekSlowModel = (process.env.DEEPSEEK_SLOW_MODEL || '').trim();
        const model = preferCloud
            ? (route === 'fast' ? (deepseekFastModel || undefined) : (deepseekSlowModel || undefined))
            : undefined;

        // Inject Control State (Backend Override + Fatigue Linkage)
        const controlManager = getControlManager();
        const controlState = controlManager.getState();
        const suggestedTopic = this.suggestTopicShift(activeSession);

        let controlSection = '';
        if (controlState.currentTopic) {
            controlSection += `\n[Control] Current Topic: ${controlState.currentTopic.topic} (Priority: ${controlState.currentTopic.priority})`;
            if (controlState.currentTopic.context) controlSection += `\n[Control] Topic Context: ${controlState.currentTopic.context}`;
        } else if (suggestedTopic) {
            const fatigue = activeSession.topicFatigue.toFixed(2);
            controlSection += `\n[Control] Suggested Next Topic: ${suggestedTopic} (Reason: current topic is exhausted; fatigue=${fatigue})`;
        }

        // 根据疲劳度分级提示：温和建议 + 强约束
        const fatigue = activeSession.topicFatigue;
        const topicLabel = activeSession.currentTopicLabel || activeSession.currentTopic || '';
        if (fatigue >= this.topicFatigueSuggestThreshold) {
            // 中文/英文根据输入自动切换
            if (TA.shouldReplyInChinese(input.content, this.preferChineseByDefault)) {
                controlSection += `\n[Topic Fatigue] 你已经围绕“${topicLabel}”聊了好几轮（疲劳度 ${fatigue.toFixed(2)}），请尝试自然收尾，或转到一个相关但不重复的新话题。`;
            } else {
                controlSection += `\n[Topic Fatigue] You have stayed on "${topicLabel}" for multiple turns (fatigue=${fatigue.toFixed(2)}). Start wrapping this up or naturally transition to a related but distinct topic instead of circling back.`;
            }
        }
        if (fatigue >= this.topicFatigueHardThreshold) {
            if (TA.shouldReplyInChinese(input.content, this.preferChineseByDefault)) {
                controlSection += `\n[Anti-Repetition Hard] 本轮回复必须提供全新信息或视角，禁止重复前几轮已说过的内容。`;
            } else {
                controlSection += `\n[Anti-Repetition Hard] This turn MUST add genuinely new information or perspective. Do NOT restate or lightly rephrase sentences you already said in the last few turns.`;
            }
        }
        // 反面示例：将上一轮回复注入 prompt，明确告知 LLM 不要再说
        if (activeSession.lastReplies.length > 0 && activeSession.topicTurnCount >= 2) {
            const recentReply = activeSession.lastReplies[activeSession.lastReplies.length - 1];
            controlSection += `\n[Anti-Repetition] Your last reply was: "${recentReply.slice(0, 80)}". You MUST say something completely different this time. Do NOT rephrase the same idea.`;
        }

        if (controlState.behavior) {
            controlSection += `\n[Control] Behavior Mode: ${controlState.behavior.mode}`;
            if (controlState.behavior.mode === 'silent') controlSection += ' (Do not speak unless critical)';
        }
        if (controlState.mood) {
            controlSection += `\n[Control] Mood Override: ${controlState.mood.mood} (Intensity: ${controlState.mood.intensity})`;
        }

        const finalSystemPrompt = `${systemPrompt}\n${controlSection}`;

        // Return everything needed for generation & post-processing
        return {
            userContent,
            systemPrompt: finalSystemPrompt,
            samplingPlan,
            maxTokens,
            model,
            preferCloud,
            forceProvider,
            strictProvider: localFastForced && this.liveForceLocalFastStrict,
            realtimeGuard,
            activeSession,
            runtimeStateEvidence,
            strategy, // needed for post-processing
            isChineseInput // needed for retries
        };
    }
    private async polishResponse(
        draft: string,
        toolContext: string | null,
        input: RawStreamInput,
        signal: BrainSignal,
        memoryContext: MemoryContext | null,
        route: ResponseRoute = 'slow',
        agentAnalysis: any = null,
        session?: SessionState
    ): Promise<PolishedResponse> {
        if (process.env.USE_LLM_API === 'false') {
            const activeSession = session || this.getOrCreateSession(input);
            const seeded = toolContext ? `${draft} (${toolContext})` : draft;
            const guarded = this.enforceConsistencyGuard(seeded, input, route, activeSession);
            this.metrics.logConsistencyStats(guarded.flags, input);
            return { text: guarded.text, provider: 'bypass' };
        }

        let activeProvider: LlmProviderName = 'unknown';
        const captureProvider = (result: any): void => {
            if (isFallbackResponse(result)) return;
            const provider = (result as any)?.provider;
            if (provider === 'local' || provider === 'deepseek') activeProvider = provider;
        };
        const wrapResponse = (text: string): PolishedResponse => ({ text, provider: activeProvider });

        try {
            const request = await this.prepareLlmRequest(
                input,
                signal,
                memoryContext,
                route,
                agentAnalysis,
                session,
                toolContext
            );

            const llmHandler = getGlobalLLMFallbackHandler();
            const timeoutMs = this.getLlmRequestTimeoutMs(input, route);
            const allowHeavyPostProcessing = !(request.realtimeGuard && this.liveSkipHeavyPostProcessing);

            const result = await llmHandler.generateResponse({
                prompt: request.userContent,
                systemPrompt: request.systemPrompt,
                temperature: request.samplingPlan.temperature,
                topP: request.samplingPlan.topP,
                maxTokens: request.maxTokens,
                model: request.model,
                preferCloud: request.preferCloud,
                forceProvider: request.forceProvider,
                strictProvider: request.strictProvider,
                timeout: timeoutMs
            });

            captureProvider(result);
            if (isFallbackResponse(result)) {
                return wrapResponse(result.text);
            }
            if (!result.success || !result.text) {
                if (route === 'fast') {
                    return wrapResponse(this.warmupPhrase);
                }
                return wrapResponse(this.buildRescueReply(input.content));
            }

            let finalCandidate = (result.text || '').trim();
            finalCandidate = this.enforceCapabilityScopeAnswer(finalCandidate, input, request.runtimeStateEvidence);

            const qualityIssue = this.detectQualityIssue(finalCandidate, input, route, request.activeSession);
            if (qualityIssue && allowHeavyPostProcessing) {
                const regenerated = await this.tryRegenerateForQualityIssue(
                    llmHandler,
                    qualityIssue,
                    finalCandidate,
                    input,
                    request.systemPrompt,
                    request.preferCloud,
                    request.model,
                    request.maxTokens,
                    route,
                    request.activeSession,
                    request.strategy
                );
                if (regenerated) {
                    finalCandidate = regenerated;
                }
            }

            const groundingIssue = this.detectStateGroundingIssue(
                finalCandidate,
                input,
                request.strategy,
                request.runtimeStateEvidence
            );
            if (groundingIssue && allowHeavyPostProcessing) {
                const grounded = await this.tryRegenerateForQualityIssue(
                    llmHandler,
                    groundingIssue,
                    finalCandidate,
                    input,
                    request.systemPrompt,
                    request.preferCloud,
                    request.model,
                    request.maxTokens,
                    route,
                    request.activeSession,
                    request.strategy
                );
                if (grounded) {
                    finalCandidate = grounded;
                }
            }

            let guarded = this.enforceConsistencyGuard(finalCandidate, input, route, request.activeSession);
            if (guarded.flags.includes('fallback_rescue') && allowHeavyPostProcessing) {
                const repaired = await this.tryDirectAnswerRepair(
                    llmHandler,
                    input,
                    route,
                    request.activeSession,
                    request.strategy,
                    request.preferCloud,
                    request.model,
                    request.maxTokens
                );
                if (repaired) {
                    guarded = this.enforceConsistencyGuard(repaired, input, route, request.activeSession);
                }
            }

            this.metrics.logConsistencyStats(guarded.flags, input);
            return wrapResponse(guarded.text);
        } catch (error: any) {
            console.error('[LLM] Error:', error?.message || error);
            return wrapResponse(this.buildRescueReply(input.content));
        }
    }
    private buildCapabilityScopeFallbackReply(input: RawStreamInput, evidence: RuntimeStateEvidence | null): string {
        const chinese = TA.shouldReplyInChinese(input.content || '', this.preferChineseByDefault);
        const states = evidence?.serviceStates || {};
        const stateOf = (id: string): 'running' | 'stopped' | 'unknown' => states[id] || 'unknown';

        const canParts: string[] = [];
        const cannotParts: string[] = [];
        const statusRows: string[] = [];
        const serviceIds = ['memory-universe', 'memory-tts', 'sovits-api', 'live2d', 'vision', 'brainnn'];

        for (const id of serviceIds) {
            statusRows.push(`${id}=${stateOf(id)}`);
        }

        if (stateOf('memory-universe') === 'running') {
            canParts.push(chinese ? '实时聊天回复' : 'real-time chat replies');
        } else {
            cannotParts.push(chinese ? '稳定聊天回复' : 'stable chat replies');
        }

        const ttsReady = stateOf('memory-tts') === 'running' || stateOf('sovits-api') === 'running';
        if (ttsReady) {
            canParts.push(chinese ? 'TTS语音合成' : 'TTS synthesis');
        } else {
            cannotParts.push(chinese ? '语音播报' : 'voice playback');
        }

        if (stateOf('live2d') === 'running') {
            canParts.push(chinese ? 'Live2D表情动作' : 'Live2D expression/actions');
        } else {
            cannotParts.push(chinese ? 'Live2D动作联动' : 'Live2D action linkage');
        }

        if (stateOf('vision') === 'running') {
            canParts.push(chinese ? '屏幕视觉理解' : 'screen visual understanding');
        } else {
            cannotParts.push(chinese ? '直接看见你的屏幕内容' : 'directly seeing your screen content');
        }

        if (evidence?.available) {
            canParts.push(chinese ? '读取开播状态并自检' : 'read readiness and run self-check');
        } else {
            cannotParts.push(chinese ? '确认全部服务的实时状态' : 'fully verify all runtime states');
        }

        if (cannotParts.length === 0) {
            cannotParts.push(chinese ? '暂未发现明确不可用项（建议继续 /readiness 复核）' : 'no clear unavailable item yet (still verify with /readiness)');
        }

        const canText = canParts.join(chinese ? '。' : ', ');
        const cannotText = cannotParts.join(chinese ? '。' : ', ');

        if (chinese) {
            if (evidence?.available) {
                return `我能做：${canText}。我目前不能保证：${cannotText}。当前探测：${statusRows.join(', ')}。`;
            }
            return `我能做：${canText}。我目前不能保证：${cannotText}。当前探测：服务状态证据不足，建议执行 /readiness。`;
        }

        if (evidence?.available) {
            return `I can do: ${canText}. I currently cannot guarantee: ${cannotText}. Current probe: ${statusRows.join(', ')}.`;
        }
        return `I can do: ${canText}. I currently cannot guarantee: ${cannotText}. Current probe: runtime evidence unavailable; run /readiness.`;
    }

    private formatCreatorEvalChatStatus(): string {
        if (this.metrics.evalChatStats.runs <= 0) {
            return '还没有运行过 /eval chat。先执行一次 /eval chat。';
        }
        const lastTime = this.metrics.evalChatStats.lastRunAt > 0
            ? new Date(this.metrics.evalChatStats.lastRunAt).toLocaleString('zh-CN', { hour12: false })
            : 'unknown';
        return [
            `EvalChat 累计 runs=${this.metrics.evalChatStats.runs}，cases=${this.metrics.evalChatStats.totalCases}，passed=${this.metrics.evalChatStats.passedCases}，fallbackHits=${this.metrics.evalChatStats.fallbackHits}。`,
            `最近一次：time=${lastTime}，avgScore=${this.metrics.evalChatStats.lastAvgScore.toFixed(1)}，passRate=${(this.metrics.evalChatStats.lastPassRate * 100).toFixed(1)}%，p95=${this.metrics.evalChatStats.lastP95LatencyMs}ms。`,
            `inFlight=${this.metrics.evalChatInFlight ? 'yes' : 'no'}`
        ].join('\n');
    }

    async getLegacyState(): Promise<PersonaStateLegacy> {
        return {
            emotionBaseline: 0.6,
            energyLevel: 0.8,
            styleWeights: { playful: 0.7, serious: 0.1, caring: 0.1, chaotic: 0.1 },
            creatorIntimacy: 0.9,
            viewerWarmth: 0.5
        };
    }

    /**
     * Phase 2: ??????
     */
    getMemoryStats() {
        return {
            ...this.vectorStore.getStats(),
            retrieval: getRetrievalStats()
        };
    }

    getIntelligenceStats() {
        const routeReasons = Object.fromEntries(this.metrics.routeReasonStats.entries());
        const totalRoutes = this.metrics.routeStats.fast + this.metrics.routeStats.slow;
        const phaseStats: Record<SessionPhase, number> = {
            opening: 0,
            interactive: 0,
            closing: 0,
            recap: 0
        };
        let openGoals = 0;
        for (const session of this.sessionState.values()) {
            phaseStats[session.phase] += 1;
            openGoals += session.goals.filter((goal) => goal.status === 'open').length;
        }
        const avgContext = this.metrics.contextBudgetStats.total > 0
            ? {
                raw: this.metrics.contextBudgetStats.raw / this.metrics.contextBudgetStats.total,
                selected: this.metrics.contextBudgetStats.selected / this.metrics.contextBudgetStats.total,
                tokensBefore: this.metrics.contextBudgetStats.tokensBefore / this.metrics.contextBudgetStats.total,
                tokensAfter: this.metrics.contextBudgetStats.tokensAfter / this.metrics.contextBudgetStats.total,
                hardNegativeDropped: this.metrics.contextBudgetStats.hardNegativeDropped / this.metrics.contextBudgetStats.total,
                lexicalAccepted: this.metrics.contextBudgetStats.lexicalAccepted / this.metrics.contextBudgetStats.total
            }
            : {
                raw: 0,
                selected: 0,
                tokensBefore: 0,
                tokensAfter: 0,
                hardNegativeDropped: 0,
                lexicalAccepted: 0
            };
        const latencyByStage = Object.fromEntries(
            Object.entries(this.metrics.latencyStats.byStage).map(([stage, bucket]) => [stage, this.metrics.summarizeLatency(bucket)])
        );
        return {
            routes: {
                ...this.metrics.routeStats,
                total: totalRoutes,
                reasons: routeReasons
            },
            moduleParticipation: {
                ...this.metrics.moduleLevelStats
            },
            consistency: { ...this.metrics.consistencyStats },
            contextBudget: {
                ...this.metrics.contextBudgetStats,
                average: avgContext
            },
            viewerGraph: {
                ...this.metrics.viewerTierStats
            },
            goals: {
                ...this.metrics.goalStats,
                open: openGoals
            },
            uncertainty: {
                ...this.metrics.uncertaintyStats
            },
            memoryWrite: {
                ...this.metrics.memoryWriteStats,
                gateEnabled: this.memoryWriteGateEnabled,
                stableMinConfidence: this.memoryStableWriteMinConfidence,
                volatileMinConfidence: this.memoryVolatileWriteMinConfidence
            },
            grounding: {
                ...this.metrics.groundingStats
            },
            capabilityScope: {
                ...this.metrics.capabilityScopeStats
            },
            generationPolicy: {
                ...this.metrics.generationPolicyStats,
                noveltyThreshold: this.noveltyMinThreshold,
                emojiMax: this.emojiMaxCount
            },
            llmRouting: {
                runtimeMode: this.llmCloudRuntimeMode,
                config: {
                    enabled: this.slowPathCloudEnabled,
                    always: this.slowPathCloudAlways,
                    complexOnly: this.slowPathCloudComplexOnly,
                    allowRandom: this.slowPathCloudAllowRandom,
                    probability: this.slowPathCloudProbability,
                    hasCloudKey: TA.hasCloudKey()
                },
                providers: {
                    ...this.metrics.llmProviderStats
                }
            },
            liveRealtime: {
                enabled: this.liveRealtimeModeEnabled,
                skipHeavyPost: this.liveSkipHeavyPostProcessing,
                forceLocalFast: this.liveForceLocalFast && this.useLocalLlmEnabled,
                fastTimeoutMs: this.liveFastLlmTimeoutMs,
                slowTimeoutMs: this.liveSlowLlmTimeoutMs,
                fastMaxTokens: this.liveFastMaxTokens,
                slowMaxTokens: this.liveSlowMaxTokens
            },
            evalChat: {
                ...this.metrics.evalChatStats,
                inFlight: this.metrics.evalChatInFlight
            },
            traitRuntime: {
                ...this.animeTraitRuntime,
                availableProfiles: this.animeTraitProfiles
            },
            toolShadow: {
                ...this.metrics.toolShadowStats
            },
            toolExecution: {
                ...this.metrics.toolExecutionStats,
                mode: this.toolExecutionMode,
                maxCalls: this.toolExecutionMaxCalls,
                minConfidence: this.toolRouteMinConfidence
            },
            latency: {
                total: this.metrics.summarizeLatency(this.metrics.latencyStats.total),
                byRoute: {
                    fast: this.metrics.summarizeLatency(this.metrics.latencyStats.byRoute.fast),
                    slow: this.metrics.summarizeLatency(this.metrics.latencyStats.byRoute.slow)
                },
                byStage: latencyByStage
            },
            sessions: {
                active: this.sessionState.size,
                phases: phaseStats
            },
            canonical: this.canonicalMemory.getStats()
        };
    }

    /**
     * Phase 2: ??????/??
     */
    async triggerDreaming() {
        return this.dreamingService.dream();
    }

    /**
     * ????
     */
    async dispose() {
        this.dreamingService.stop();
        await this.vectorStore.dispose();
        this.canonicalMemory.dispose();
    }
}
