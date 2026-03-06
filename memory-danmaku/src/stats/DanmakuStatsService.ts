/**
 * 弹幕统计服务 - M2 WorldState 信号源
 * 
 * 功能：
 * - danmaku_density_10s: 每10秒弹幕密度
 * - hot_topics_300s: 最近5分钟词频统计
 * - audience_pulse: 观众情绪（基于词典）
 */

export interface DanmakuStats {
    danmakuDensity10s: number;
    hotTopics300s: string[];
    audiencePulse: number;
    lastUpdate: number;
}

export interface WordFrequency {
    word: string;
    count: number;
    lastSeen: number;
}

const POSITIVE_WORDS = new Set([
    '好', '棒', '赞', '厉害', '牛逼', '666', '6666', '厉害', '强', '优秀',
    '可爱', '萌', '喜欢', '爱', '哈哈', '哈哈哈', '笑', '开心', '高兴',
    '加油', '支持', '感谢', '谢谢', '太棒了', '太强了', '绝了', '神了',
    '好听', '好看', '美', '漂亮', '帅', '酷', '牛逼', 'yyds', '永远的神',
    '冲', '冲冲冲', '来了', '打卡', '签到', '投币', '点赞', '关注',
    '嘿嘿', '嘻嘻', '呵呵', '哈哈', '233', '2333', '23333', '草', '笑死',
    '不错', '挺好', '还行', '可以', 'ok', 'OK', 'nice', 'Nice', 'NICE',
    '太可爱了', '太萌了', '爱了', '心动', '心动了', '沦陷', '破防',
]);

const NEGATIVE_WORDS = new Set([
    '无聊', '没意思', '垃圾', '废物', '傻', '蠢', '笨', '差', '烂',
    '恶心', '讨厌', '烦', '烦人', '吵', '吵死', '闭嘴', '滚', '滚蛋',
    '失望', '无语', '服了', '醉了', '累了', '困了', '无聊死了',
    '不行', '不可以', '不能', '不要', '别', '别这样', '别闹',
    '卡', '卡顿', '卡死', '掉线', '断网', '延迟', '卡顿',
    '难听', '难看', '丑', '恶心', '反胃', '吐了',
]);

const STOP_WORDS = new Set([
    '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一',
    '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有',
    '看', '好', '自己', '这', '那', '他', '她', '它', '们', '这个', '那个',
    '什么', '怎么', '为什么', '哪', '哪里', '谁', '多少', '几', '吗', '呢',
    '啊', '吧', '哦', '嗯', '哈', '呵', '嘿', '嘻', '哎', '唉', '噢',
    '呀', '哇', '哎哟', '哎呀', '额', '呃', '唔', '喔', '咯', '嘞',
    '嘛', '么', '咧', '喽', '咯', '啰', '嘢', '哒', '滴', '咧',
    '哈哈', '哈哈哈', '哈哈哈哈', '233', '2333', '23333', '666', '6666',
]);

const MIN_WORD_LENGTH = 2;
const MAX_WORD_LENGTH = 8;
const MAX_HOT_TOPICS = 10;
const DENSITY_WINDOW_MS = 10000;
const TOPICS_WINDOW_MS = 300000;
const PULSE_WINDOW_MS = 120000;

export class DanmakuStatsService {
    private densityWindow: number[] = [];
    private wordFrequencies: Map<string, WordFrequency> = new Map();
    private sentimentWindow: Array<{ timestamp: number; score: number }> = [];
    private lastStats: DanmakuStats = {
        danmakuDensity10s: 0,
        hotTopics300s: [],
        audiencePulse: 0.5,
        lastUpdate: Date.now(),
    };

    private cleanupInterval: NodeJS.Timeout | null = null;

    constructor() {
        this.startCleanupInterval();
    }

    private startCleanupInterval(): void {
        this.cleanupInterval = setInterval(() => {
            this.cleanupOldData();
        }, 30000);
    }

    private cleanupOldData(): void {
        const now = Date.now();
        const densityCutoff = now - DENSITY_WINDOW_MS;
        const topicsCutoff = now - TOPICS_WINDOW_MS;
        const pulseCutoff = now - PULSE_WINDOW_MS;

        this.densityWindow = this.densityWindow.filter(t => t > densityCutoff);

        for (const [word, data] of this.wordFrequencies.entries()) {
            if (data.lastSeen < topicsCutoff) {
                this.wordFrequencies.delete(word);
            }
        }

        this.sentimentWindow = this.sentimentWindow.filter(s => s.timestamp > pulseCutoff);
    }

    processDanmaku(text: string, userName?: string): void {
        const now = Date.now();

        this.densityWindow.push(now);

        const words = this.extractWords(text);
        for (const word of words) {
            const existing = this.wordFrequencies.get(word);
            if (existing) {
                existing.count++;
                existing.lastSeen = now;
            } else {
                this.wordFrequencies.set(word, { word, count: 1, lastSeen: now });
            }
        }

        const sentiment = this.analyzeSentiment(text);
        this.sentimentWindow.push({ timestamp: now, score: sentiment });

        this.updateStats(now);
    }

    private extractWords(text: string): string[] {
        const words: string[] = [];
        const cleanText = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ');
        const tokens = cleanText.split(/\s+/).filter(Boolean);

        for (const token of tokens) {
            if (token.length >= MIN_WORD_LENGTH && token.length <= MAX_WORD_LENGTH) {
                if (!STOP_WORDS.has(token) && !/^\d+$/.test(token)) {
                    words.push(token.toLowerCase());
                }
            }

            if (token.length > MAX_WORD_LENGTH) {
                for (let i = 0; i <= token.length - MIN_WORD_LENGTH; i++) {
                    for (let len = MIN_WORD_LENGTH; len <= MAX_WORD_LENGTH && i + len <= token.length; len++) {
                        const sub = token.substring(i, i + len);
                        if (!STOP_WORDS.has(sub) && !/^\d+$/.test(sub)) {
                            words.push(sub.toLowerCase());
                        }
                    }
                }
            }
        }

        return words;
    }

    private analyzeSentiment(text: string): number {
        let score = 0;
        let count = 0;

        const chars = text.split('');
        for (let i = 0; i < chars.length; i++) {
            for (let len = 1; len <= 4 && i + len <= text.length; len++) {
                const word = text.substring(i, i + len);
                if (POSITIVE_WORDS.has(word)) {
                    score += 1;
                    count++;
                } else if (NEGATIVE_WORDS.has(word)) {
                    score -= 1;
                    count++;
                }
            }
        }

        if (count === 0) return 0.5;

        const normalized = (score / count + 1) / 2;
        return Math.max(0, Math.min(1, normalized));
    }

    private updateStats(now: number): void {
        const densityCutoff = now - DENSITY_WINDOW_MS;
        const densityCount = this.densityWindow.filter(t => t > densityCutoff).length;
        const densityPerSecond = densityCount / (DENSITY_WINDOW_MS / 1000);
        this.lastStats.danmakuDensity10s = Math.round(densityPerSecond * 100) / 100;

        const sortedWords = Array.from(this.wordFrequencies.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, MAX_HOT_TOPICS);
        this.lastStats.hotTopics300s = sortedWords.map(w => w.word);

        if (this.sentimentWindow.length > 0) {
            const avgSentiment = this.sentimentWindow.reduce((sum, s) => sum + s.score, 0) / this.sentimentWindow.length;
            this.lastStats.audiencePulse = Math.round(avgSentiment * 1000) / 1000;
        }

        this.lastStats.lastUpdate = now;
    }

    getStats(): DanmakuStats {
        return { ...this.lastStats };
    }

    getStatsForWorldState(): {
        danmaku_density_10s: number;
        hot_topics_300s: string[];
        audience_pulse: number;
    } {
        return {
            danmaku_density_10s: this.lastStats.danmakuDensity10s,
            hot_topics_300s: this.lastStats.hotTopics300s,
            audience_pulse: this.lastStats.audiencePulse,
        };
    }

    reset(): void {
        this.densityWindow = [];
        this.wordFrequencies.clear();
        this.sentimentWindow = [];
        this.lastStats = {
            danmakuDensity10s: 0,
            hotTopics300s: [],
            audiencePulse: 0.5,
            lastUpdate: Date.now(),
        };
    }

    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
}

let instance: DanmakuStatsService | null = null;

export function getDanmakuStatsService(): DanmakuStatsService {
    if (!instance) {
        instance = new DanmakuStatsService();
    }
    return instance;
}
