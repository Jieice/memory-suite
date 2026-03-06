/**
 * 后台控制管理器
 * 用于控制AI的话题、行为模式、情绪状态等
 */

import { EventEmitter } from 'events';

export type BehaviorMode = 'proactive' | 'reactive' | 'silent';
export type MoodType = 'happy' | 'excited' | 'calm' | 'curious' | 'playful' | 'serious' | 'energetic' | 'relaxed';

export interface TopicState {
    topic: string;
    context?: string;
    priority: 'high' | 'normal' | 'low';
    startedAt: number;
    endedAt?: number;
}

export interface MoodState {
    mood: MoodType;
    intensity: number; // 0-1
    startedAt: number;
    expiresAt?: number;
}

export interface BehaviorState {
    mode: BehaviorMode;
    startedAt: number;
    expiresAt?: number;
    reason?: string;
}

export interface ControlAction {
    type: 'topic_start' | 'topic_switch' | 'topic_end' | 'behavior_set' | 'mood_set' | 'command';
    data: any;
    priority: number;
    timestamp: number;
}

export type ControlCommand =
    | 'say_hello'
    | 'tell_joke'
    | 'ask_question'
    | 'share_story'
    | 'react_to_danmaku'
    | 'check_audience'
    | 'promote_topic';

const TOPIC_POOL = [
    { topic: '日常分享', context: '分享一个今天遇到的小趣事或者小知识' },
    { topic: '情感互动', context: '询问观众最近的心情，或者分享一些温馨的话语' },
    { topic: '未来展望', context: '聊聊对以后直播内容的规划，或者想尝试的新鲜事物' },
    { topic: '技术探讨', context: '简单聊聊直播设备、软件或者AI技术的小知识' },
    { topic: '兴趣爱好', context: '聊聊喜欢的动漫、游戏或者音乐' },
    { topic: '互动提问', context: '向观众提一个有趣的问题，引导大家发弹幕' }
];

export class ControlManager extends EventEmitter {
    private currentTopic?: TopicState;
    private topicStack: TopicState[] = [];
    private behaviorState: BehaviorState = { mode: 'reactive', startedAt: Date.now() };
    private moodOverride?: MoodState;
    private commandQueue: ControlAction[] = [];
    private isProcessingCommand = false;

    /**
     * 启动新话题
     */
    startTopic(topic: string, context?: string, priority: 'high' | 'normal' | 'low' = 'normal'): void {
        // 如果当前有话题，先保存到栈中
        if (this.currentTopic) {
            this.topicStack.push(this.currentTopic);
        }

        const topicState: TopicState = {
            topic,
            context,
            priority,
            startedAt: Date.now()
        };

        this.currentTopic = topicState;
        this.emit('topic_started', topicState);

        console.log(`[ControlManager] 🎯 话题启动: ${topic} (优先级: ${priority})`);
    }

    /**
     * 切换话题
     */
    switchTopic(
        fromTopic: string | undefined,
        toTopic: string,
        transition: 'smooth' | 'abrupt' = 'smooth',
        context?: string
    ): void {
        // 如果指定了fromTopic，验证当前话题是否匹配
        if (fromTopic && this.currentTopic?.topic !== fromTopic) {
            console.warn(`[ControlManager] ⚠️ 当前话题不匹配: 期望 ${fromTopic}, 实际 ${this.currentTopic?.topic}`);
        }

        // 结束当前话题
        if (this.currentTopic) {
            this.currentTopic.endedAt = Date.now();
            this.topicStack.push(this.currentTopic);
        }

        // 启动新话题
        const priority = transition === 'abrupt' ? 'high' : 'normal';
        this.startTopic(toTopic, context, priority);

        this.emit('topic_switched', {
            from: fromTopic,
            to: toTopic,
            transition,
            timestamp: Date.now()
        });

        console.log(`[ControlManager] 🔄 话题切换: ${fromTopic || '无'} → ${toTopic} (${transition})`);
    }

    /**
     * 结束话题
     */
    endTopic(topic: string, reason?: string): void {
        if (this.currentTopic?.topic === topic) {
            this.currentTopic.endedAt = Date.now();
            const endedTopic = this.currentTopic;
            this.topicStack.push(endedTopic);
            this.currentTopic = undefined;

            this.emit('topic_ended', { topic, reason, timestamp: Date.now() });
            console.log(`[ControlManager] ✅ 话题结束: ${topic}${reason ? ` (原因: ${reason})` : ''}`);
        } else {
            console.warn(`[ControlManager] ⚠️ 尝试结束不存在的话题: ${topic}`);
        }
    }

    /**
     * 设置行为模式
     */
    setBehavior(mode: BehaviorMode, duration?: number, reason?: string): void {
        const expiresAt = duration ? Date.now() + duration * 1000 : undefined;

        this.behaviorState = {
            mode,
            startedAt: Date.now(),
            expiresAt,
            reason
        };

        this.emit('behavior_changed', this.behaviorState);
        console.log(`[ControlManager] 🎭 行为模式: ${mode}${duration ? ` (持续 ${duration}秒)` : ' (永久)'}${reason ? ` - ${reason}` : ''}`);
    }

    /**
     * 设置情绪状态
     */
    setMood(mood: MoodType, intensity: number = 0.7, duration?: number): void {
        const expiresAt = duration ? Date.now() + duration * 1000 : undefined;

        this.moodOverride = {
            mood,
            intensity: Math.max(0, Math.min(1, intensity)),
            startedAt: Date.now(),
            expiresAt
        };

        this.emit('mood_changed', this.moodOverride);
        console.log(`[ControlManager] 😊 情绪设置: ${mood} (强度: ${intensity})${duration ? ` (持续 ${duration}秒)` : ' (永久)'}`);
    }

    /**
     * 执行控制指令
     */
    async executeCommand(command: ControlCommand, params?: Record<string, any>): Promise<string> {
        const action: ControlAction = {
            type: 'command',
            data: { command, params },
            priority: 10, // 指令优先级最高
            timestamp: Date.now()
        };

        this.commandQueue.push(action);
        this.commandQueue.sort((a, b) => b.priority - a.priority);

        // 处理队列
        return this.processCommandQueue();
    }

    /**
     * 处理指令队列
     */
    private async processCommandQueue(): Promise<string> {
        if (this.isProcessingCommand || this.commandQueue.length === 0) {
            return '';
        }

        this.isProcessingCommand = true;
        const action = this.commandQueue.shift()!;

        try {
            let result = '';

            switch (action.data.command) {
                case 'say_hello':
                    result = await this.handleSayHello(action.data.params);
                    break;
                case 'tell_joke':
                    result = await this.handleTellJoke(action.data.params);
                    break;
                case 'ask_question':
                    result = await this.handleAskQuestion(action.data.params);
                    break;
                case 'share_story':
                    result = await this.handleShareStory(action.data.params);
                    break;
                case 'react_to_danmaku':
                    result = await this.handleReactToDanmaku(action.data.params);
                    break;
                case 'check_audience':
                    result = await this.handleCheckAudience(action.data.params);
                    break;
                case 'promote_topic':
                    result = await this.handlePromoteTopic(action.data.params);
                    break;
                default:
                    result = `未知指令: ${action.data.command}`;
            }

            this.emit('command_executed', { command: action.data.command, result, timestamp: Date.now() });
            return result;
        } catch (error: any) {
            console.error(`[ControlManager] ❌ 指令执行失败: ${action.data.command}`, error);
            this.emit('command_error', { command: action.data.command, error: error.message });
            throw error;
        } finally {
            this.isProcessingCommand = false;
            // 继续处理队列
            if (this.commandQueue.length > 0) {
                setTimeout(() => this.processCommandQueue(), 100);
            }
        }
    }

    /**
     * 检查是否有控制指令需要执行
     */
    checkControlPriority(input: any): ControlAction | null {
        // 检查是否有高优先级指令
        if (this.commandQueue.length > 0 && this.commandQueue[0].priority >= 10) {
            return this.commandQueue[0];
        }

        // 检查行为模式
        if (this.behaviorState.mode === 'silent') {
            return {
                type: 'behavior_set',
                data: { mode: 'silent' },
                priority: 5,
                timestamp: Date.now()
            };
        }

        // 检查当前话题
        if (this.currentTopic && this.currentTopic.priority === 'high') {
            return {
                type: 'topic_start',
                data: { topic: this.currentTopic.topic, context: this.currentTopic.context },
                priority: 8,
                timestamp: Date.now()
            };
        }

        return null;
    }

    /**
     * 获取当前状态
     */
    getState() {
        return {
            currentTopic: this.currentTopic,
            topicStack: this.topicStack.slice(-5), // 最近5个话题
            behavior: this.behaviorState,
            mood: this.moodOverride,
            pendingCommands: this.commandQueue.length
        };
    }

    /**
     * 获取推荐话题（用于话题联动）
     */
    suggestTopic(): { topic: string; context?: string } | null {
        const index = Math.floor(Math.random() * TOPIC_POOL.length);
        return TOPIC_POOL[index] || null;
    }

    /**
     * 清理过期状态
     */
    cleanup(): void {
        const now = Date.now();

        // 清理过期的行为模式
        if (this.behaviorState.expiresAt && this.behaviorState.expiresAt < now) {
            this.setBehavior('reactive');
        }

        // 清理过期的情绪
        if (this.moodOverride?.expiresAt && this.moodOverride.expiresAt < now) {
            this.moodOverride = undefined;
            this.emit('mood_expired');
        }
    }

    // 指令处理函数
    private async handleSayHello(params?: Record<string, any>): Promise<string> {
        const target = params?.target || '大家';
        return `你好，${target}！很高兴见到你们！`;
    }

    private async handleTellJoke(params?: Record<string, any>): Promise<string> {
        const jokes = [
            '为什么程序员总是分不清万圣节和圣诞节？因为 Oct 31 == Dec 25！',
            '为什么AI不会累？因为它一直在学习！',
            '你知道AI最怕什么吗？断电！',
        ];
        const joke = jokes[Math.floor(Math.random() * jokes.length)];
        return joke;
    }

    private async handleAskQuestion(params?: Record<string, any>): Promise<string> {
        const question = params?.question || '你们今天过得怎么样？';
        return question;
    }

    private async handleShareStory(params?: Record<string, any>): Promise<string> {
        const story = params?.story || '让我分享一个小故事...';
        return story;
    }

    private async handleReactToDanmaku(params?: Record<string, any>): Promise<string> {
        const danmaku = params?.danmaku || '';
        return `我看到了这条弹幕："${danmaku}"，很有意思呢！`;
    }

    private async handleCheckAudience(params?: Record<string, any>): Promise<string> {
        return '让我看看现在有多少观众在线...';
    }

    private async handlePromoteTopic(params?: Record<string, any>): Promise<string> {
        const topic = params?.topic || this.currentTopic?.topic || '当前话题';
        return `让我们聊聊${topic}吧！`;
    }
}

// 单例
let controlManagerInstance: ControlManager | null = null;

export function getControlManager(): ControlManager {
    if (!controlManagerInstance) {
        controlManagerInstance = new ControlManager();
        // 定期清理过期状态
        setInterval(() => {
            controlManagerInstance?.cleanup();
        }, 60000); // 每分钟清理一次
    }
    return controlManagerInstance;
}
