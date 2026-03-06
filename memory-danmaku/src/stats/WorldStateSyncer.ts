/**
 * WorldState 同步器 - 将弹幕统计数据同步到 BrainNN
 * 
 * 每 10 秒向 BrainNN /world/update 发送：
 * - activity: 当前活动
 * - atmosphere: 房间氛围
 * - danmaku_density_10s: 弹幕密度
 * - hot_topics_300s: 热门话题
 * - audience_pulse: 观众情绪
 */

import axios from 'axios';
import { getDanmakuStatsService, DanmakuStatsService } from './DanmakuStatsService.js';

export interface WorldStateUpdate {
    activity?: string;
    atmosphere?: number;
    danmaku_density?: number;
    hot_topics?: string[];
    audience_pulse?: number;
}

export interface WorldStateSyncConfig {
    brainnnUrl: string;
    syncIntervalMs: number;
    defaultActivity: string;
}

const DEFAULT_CONFIG: WorldStateSyncConfig = {
    brainnnUrl: process.env.BRAINNN_URL || 'http://127.0.0.1:4007',
    syncIntervalMs: 10000,
    defaultActivity: '杂谈',
};

export class WorldStateSyncer {
    private config: WorldStateSyncConfig;
    private statsService: DanmakuStatsService;
    private syncInterval: NodeJS.Timeout | null = null;
    private currentActivity: string;
    private lastSyncSuccess: boolean = false;
    private syncCount: number = 0;
    private logger: (...args: any[]) => void;

    constructor(
        config: Partial<WorldStateSyncConfig> = {},
        logger?: (...args: any[]) => void
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.statsService = getDanmakuStatsService();
        this.currentActivity = this.config.defaultActivity;
        this.logger = logger || console.log;
    }

    start(): void {
        if (this.syncInterval) {
            this.logger('[WorldStateSync] 已在运行中');
            return;
        }

        this.syncInterval = setInterval(() => {
            this.sync().catch(err => {
                this.logger('[WorldStateSync] 同步失败:', err.message);
            });
        }, this.config.syncIntervalMs);

        this.sync().catch(() => {});
        this.logger(`[WorldStateSync] 已启动，间隔 ${this.config.syncIntervalMs}ms`);
    }

    stop(): void {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
            this.logger('[WorldStateSync] 已停止');
        }
    }

    setActivity(activity: string): void {
        this.currentActivity = activity || this.config.defaultActivity;
        this.logger(`[WorldStateSync] 活动更新: ${this.currentActivity}`);
    }

    private async sync(): Promise<void> {
        const stats = this.statsService.getStatsForWorldState();

        const atmosphere = this.calculateAtmosphere(stats);

        const payload: WorldStateUpdate = {
            activity: this.currentActivity,
            atmosphere,
            danmaku_density: stats.danmaku_density_10s,
            hot_topics: stats.hot_topics_300s,
            audience_pulse: stats.audience_pulse,
        };

        try {
            const response = await axios.post(
                `${this.config.brainnnUrl}/world/update`,
                payload,
                { timeout: 2000 }
            );

            this.lastSyncSuccess = true;
            this.syncCount++;

            if (this.syncCount % 6 === 0) {
                this.logger(
                    `[WorldStateSync] 同步成功 #${this.syncCount}:`,
                    `density=${stats.danmaku_density_10s.toFixed(1)}/s`,
                    `pulse=${stats.audience_pulse.toFixed(2)}`,
                    `topics=${stats.hot_topics_300s.slice(0, 3).join(',')}`
                );
            }
        } catch (error: any) {
            this.lastSyncSuccess = false;
            if (error.code !== 'ECONNREFUSED') {
                this.logger('[WorldStateSync] 同步失败:', error.message);
            }
        }
    }

    private calculateAtmosphere(stats: {
        danmaku_density_10s: number;
        audience_pulse: number;
    }): number {
        const densityFactor = Math.min(1, stats.danmaku_density_10s / 5);
        const pulseFactor = stats.audience_pulse;
        const atmosphere = densityFactor * 0.6 + pulseFactor * 0.4;
        return Math.round(atmosphere * 1000) / 1000;
    }

    getStatus(): {
        isRunning: boolean;
        lastSyncSuccess: boolean;
        syncCount: number;
        currentActivity: string;
    } {
        return {
            isRunning: this.syncInterval !== null,
            lastSyncSuccess: this.lastSyncSuccess,
            syncCount: this.syncCount,
            currentActivity: this.currentActivity,
        };
    }
}

let instance: WorldStateSyncer | null = null;

export function getWorldStateSyncer(
    config?: Partial<WorldStateSyncConfig>,
    logger?: (...args: any[]) => void
): WorldStateSyncer {
    if (!instance) {
        instance = new WorldStateSyncer(config, logger);
    }
    return instance;
}
