import { RawStreamInput } from '../types/brain';
import {
    ResponseRoute,
    ViewerTier,
    ContextBudgetResult,
    ModuleParticipationLevel,
    LatencyBucket,
    LlmProviderName,
} from './OrchestratorTypes';

export class MetricsService {
    constructor(private readonly latencySampleCap: number) {}

    readonly consistencyStats = {
        total: 0,
        nameQueries: 0,
        nameQueryHits: 0,
        nameConflictFixes: 0,
        styleFixes: 0,
        lengthFixes: 0
    };
    readonly routeStats: Record<ResponseRoute, number> = { fast: 0, slow: 0 };
    readonly routeReasonStats = new Map<string, number>();
    readonly moduleLevelStats: Record<ModuleParticipationLevel, number> = {
        minimal: 0,
        balanced: 0,
        full: 0
    };
    readonly viewerTierStats: Record<ViewerTier, number> = { new: 0, regular: 0, core: 0 };
    readonly contextBudgetStats = {
        total: 0,
        raw: 0,
        selected: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        hardNegativeDropped: 0,
        lexicalAccepted: 0
    };
    readonly goalStats = {
        opened: 0,
        closed: 0,
        nudges: 0
    };
    readonly uncertaintyStats = {
        detected: 0,
        triggered: 0
    };
    readonly memoryWriteStats = {
        evaluated: 0,
        stableAccepted: 0,
        volatileAccepted: 0,
        rejected: 0,
        conflictsDetected: 0,
        creatorProfileWrites: 0
    };
    readonly groundingStats = {
        stateQueries: 0,
        evidenceFetched: 0,
        evidenceMissing: 0,
        evidenceConflicts: 0,
        creatorTurns: 0
    };
    readonly capabilityScopeStats = {
        queries: 0,
        fallbackApplied: 0,
        overclaimDetected: 0
    };
    readonly generationPolicyStats = {
        evaluated: 0,
        dualCandidates: 0,
        noveltyRewrites: 0,
        alternativesAccepted: 0,
        emojiTrimmed: 0
    };
    readonly toolShadowStats = {
        evaluated: 0,
        triggered: 0
    };
    readonly toolExecutionStats = {
        attempted: 0,
        executed: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        routed: 0
    };
    readonly llmProviderStats: Record<LlmProviderName, number> = {
        local: 0,
        deepseek: 0,
        unknown: 0,
        none: 0,
        bypass: 0
    };
    evalChatInFlight = false;
    readonly evalChatStats = {
        runs: 0,
        totalCases: 0,
        passedCases: 0,
        fallbackHits: 0,
        lastRunAt: 0,
        lastAvgScore: 0,
        lastPassRate: 0,
        lastP95LatencyMs: 0
    };
    readonly latencyStats: {
        total: LatencyBucket;
        byRoute: Record<ResponseRoute, LatencyBucket>;
        byStage: Record<string, LatencyBucket>;
    } = {
        total: { count: 0, totalMs: 0, maxMs: 0, samples: [] },
        byRoute: {
            fast: { count: 0, totalMs: 0, maxMs: 0, samples: [] },
            slow: { count: 0, totalMs: 0, maxMs: 0, samples: [] }
        },
        byStage: {}
    };

    logConsistencyStats(flags: string[], input: RawStreamInput): void {
        this.consistencyStats.total += 1;
        if (flags.includes('name_query_hit')) this.consistencyStats.nameQueryHits += 1;
        if (flags.includes('name_conflict_fixed')) this.consistencyStats.nameConflictFixes += 1;
        if (flags.includes('style_meta_removed')) this.consistencyStats.styleFixes += 1;
        if (flags.includes('length_trimmed')) this.consistencyStats.lengthFixes += 1;
        if (flags.includes('emoji_trimmed')) this.generationPolicyStats.emojiTrimmed += 1;

        if (flags.length > 0) {
            console.log(
                `[ConsistencyGuard] rid=${input.requestId || 'na'} flags=${flags.join(',')} stats=${JSON.stringify(this.consistencyStats)}`
            );
        }
    }

    recordRoute(route: ResponseRoute, reason: string): void {
        this.routeStats[route] += 1;
        const key = `${route}:${reason || 'unknown'}`;
        this.routeReasonStats.set(key, (this.routeReasonStats.get(key) || 0) + 1);
    }

    recordViewerTier(tier: ViewerTier): void {
        this.viewerTierStats[tier] += 1;
    }

    recordContextBudget(metrics: ContextBudgetResult): void {
        this.contextBudgetStats.total += 1;
        this.contextBudgetStats.raw += metrics.rawCount;
        this.contextBudgetStats.selected += metrics.selectedCount;
        this.contextBudgetStats.tokensBefore += metrics.tokensBefore;
        this.contextBudgetStats.tokensAfter += metrics.tokensAfter;
        this.contextBudgetStats.hardNegativeDropped += metrics.hardNegativeDropped;
        this.contextBudgetStats.lexicalAccepted += metrics.lexicalAccepted;
    }

    observeLatency(bucket: LatencyBucket, rawMs: number): void {
        const ms = Math.max(0, Math.round(rawMs));
        bucket.count += 1;
        bucket.totalMs += ms;
        bucket.maxMs = Math.max(bucket.maxMs, ms);
        bucket.samples.push(ms);
        if (bucket.samples.length > this.latencySampleCap) {
            bucket.samples.shift();
        }
    }

    recordTurnLatency(route: ResponseRoute, rawMs: number): void {
        this.observeLatency(this.latencyStats.total, rawMs);
        this.observeLatency(this.latencyStats.byRoute[route], rawMs);
    }

    recordStageLatency(stage: string, rawMs: number): void {
        if (!stage) return;
        if (!this.latencyStats.byStage[stage]) {
            this.latencyStats.byStage[stage] = { count: 0, totalMs: 0, maxMs: 0, samples: [] };
        }
        this.observeLatency(this.latencyStats.byStage[stage], rawMs);
    }

    summarizeLatency(bucket: LatencyBucket): { count: number; avgMs: number; p95Ms: number; maxMs: number; } {
        if (!bucket || bucket.count === 0) {
            return { count: 0, avgMs: 0, p95Ms: 0, maxMs: 0 };
        }

        const sorted = [...bucket.samples].sort((a, b) => a - b);
        const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
        const p95 = sorted[p95Index] || 0;
        return {
            count: bucket.count,
            avgMs: Number((bucket.totalMs / bucket.count).toFixed(1)),
            p95Ms: p95,
            maxMs: bucket.maxMs
        };
    }
}
