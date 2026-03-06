export interface ThinkingState {
    currentGoal: string | null;
    planSteps: string[];
    reasoningChain: string[];
    confidence: number;
}

export interface ProactiveState {
    lastProactiveTime: number;
    proactiveCount: number;
    topicsDiscussed: string[];
    cooldownSeconds: number;
}

export class InlineAgentCore {
    private thinkingState: ThinkingState = {
        currentGoal: null,
        planSteps: [],
        reasoningChain: [],
        confidence: 0.5,
    };
    
    private proactiveState: ProactiveState = {
        lastProactiveTime: 0,
        proactiveCount: 0,
        topicsDiscussed: [],
        cooldownSeconds: 180,
    };
    
    canProactive(): boolean {
        const elapsed = Date.now() - this.proactiveState.lastProactiveTime;
        return elapsed >= this.proactiveState.cooldownSeconds * 1000;
    }
    
    markProactive(topic: string): void {
        this.proactiveState.lastProactiveTime = Date.now();
        this.proactiveState.proactiveCount++;
        this.proactiveState.topicsDiscussed.push(topic);
        if (this.proactiveState.topicsDiscussed.length > 10) {
            this.proactiveState.topicsDiscussed = this.proactiveState.topicsDiscussed.slice(-10);
        }
    }
    
    analyzeSituation(soulState: any, context: any): { dominantEmotion: string; goal: string; reasoning: string[]; urgency: number } {
        const emotion = soulState?.emotion || {};
        const drives = soulState?.drives || {};
        
        const dominantEmotion = Object.entries(emotion).length > 0
            ? (Object.entries(emotion) as [string, number][]).sort((a, b) => b[1] - a[1])[0][0]
            : 'neutral';
        
        const boredom = drives.boredom || 0;
        const socialNeed = drives.social_need || 0;
        const curiosity = drives.curiosity || 0;
        
        const reasoning: string[] = [];
        if (boredom > 0.7) reasoning.push('检测到无聊度较高，需要寻找有趣话题');
        if (socialNeed > 0.7) reasoning.push('社交需求偏高，适合主动互动');
        if (curiosity > 0.6) reasoning.push('好奇心驱动，可以提问或探索');
        
        let goal = 'maintain_engagement';
        if (boredom > 0.7 || socialNeed > 0.7) goal = 'initiate_conversation';
        else if (curiosity > 0.6) goal = 'explore_topic';
        
        return {
            dominantEmotion,
            goal,
            reasoning,
            urgency: Math.max(boredom, socialNeed, curiosity),
        };
    }
    
    shouldProactiveSpeak(soulState: any, timeSinceLastMs: number): { shouldSpeak: boolean; topic: string | null } {
        if (!this.canProactive()) {
            return { shouldSpeak: false, topic: null };
        }
        
        const drives = soulState?.drives || {};
        const boredom = drives.boredom || 0;
        const socialNeed = drives.social_need || 0;
        
        let shouldSpeak = false;
        let topic: string | null = null;
        
        if (boredom > 0.75) {
            shouldSpeak = true;
            topic = this.generateTopic('boredom');
        } else if (socialNeed > 0.7 && timeSinceLastMs > 180000) {
            shouldSpeak = true;
            topic = this.generateTopic('social');
        } else if (timeSinceLastMs > 300000) {
            shouldSpeak = true;
            topic = this.generateTopic('timeout');
        }
        
        if (shouldSpeak && topic) {
            this.markProactive(topic);
        }
        
        return { shouldSpeak, topic };
    }
    
    private generateTopic(reason: string): string {
        const topics: Record<string, string[]> = {
            boredom: ['最近有什么有趣的事情吗？', '大家今天过得怎么样？', '有人想聊天吗？'],
            social: ['好久没和大家聊天了', '想念大家了', '有人在线吗？'],
            timeout: ['还有人在吗？', '大家都去哪了？', '有人在听吗？'],
        };
        const list = topics[reason] || topics.boredom;
        return list[Math.floor(Math.random() * list.length)];
    }
    
    getStats(): { thinkingState: ThinkingState; proactiveState: Omit<ProactiveState, 'topicsDiscussed'> & { topicsCount: number } } {
        return {
            thinkingState: this.thinkingState,
            proactiveState: {
                lastProactiveTime: this.proactiveState.lastProactiveTime,
                proactiveCount: this.proactiveState.proactiveCount,
                cooldownSeconds: this.proactiveState.cooldownSeconds,
                topicsCount: this.proactiveState.topicsDiscussed.length,
            },
        };
    }
}
