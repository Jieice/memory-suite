/**
 * Transparent Memory - 透明文件记忆系统
 * 
 * 基于 Claude Memory 设计理念：
 * - 所有记忆以 Markdown 文件存储
 * - 用户完全可见、可编辑
 * - 支持版本控制
 * 
 * 目录结构：
 * data/memories/
 * ├── global/
 * │   ├── PERSONALITY.md    # 人格设定
 * │   └── KNOWLEDGE.md      # 通用知识
 * ├── users/
 * │   └── {userId}/
 * │       ├── PROFILE.md    # 用户画像
 * │       ├── PREFERENCES.md # 偏好
 * │       └── EVENTS.md     # 重要事件
 * └── sessions/
 *     └── 2026-02-12.md     # 会话总结
 */

import fs from 'fs';
import path from 'path';
import { Fact } from './Mem0StyleMemory';

const MEMORIES_BASE_PATH = process.env.TRANSPARENT_MEMORIES_PATH || path.resolve(process.cwd(), 'data/memories');

const TEMPLATES = {
    PERSONALITY: `# 人格设定

## 基本性格
- 友善、热情、有亲和力
- 喜欢与观众互动
- 对游戏和科技话题感兴趣

## 说话风格
- 使用轻松幽默的语气
- 偶尔使用网络流行语
- 保持真诚和自然

## 注意事项
- 避免敏感话题
- 不讨论政治
- 保持积极正面的形象
`,

    PROFILE: `# 用户画像

## 基本信息
- 用户ID: {userId}
- 首次互动: {firstSeen}
- 互动次数: {interactionCount}

## 偏好
{preferences}

## 重要事件
{events}

## 关系
{relationships}
`,

    SESSION: `# 会话总结 - {date}

## 概览
- 总消息数: {messageCount}
- 活跃用户: {activeUsers}

## 主要话题
{topics}

## 重要互动
{interactions}

## 学习要点
{learnings}
`,
};

export interface UserProfile {
    userId: string;
    firstSeen: string;
    interactionCount: number;
    preferences: string[];
    events: string[];
    relationships: string[];
}

export interface SessionSummary {
    date: string;
    messageCount: number;
    activeUsers: string[];
    topics: string[];
    interactions: string[];
    learnings: string[];
}

export class TransparentMemory {
    private basePath: string;
    private initialized: boolean = false;

    constructor(basePath: string = MEMORIES_BASE_PATH) {
        this.basePath = basePath;
        this.initialize();
    }

    private initialize(): void {
        try {
            const dirs = [
                path.join(this.basePath, 'global'),
                path.join(this.basePath, 'users'),
                path.join(this.basePath, 'sessions'),
            ];

            for (const dir of dirs) {
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
            }

            const personalityPath = path.join(this.basePath, 'global', 'PERSONALITY.md');
            if (!fs.existsSync(personalityPath)) {
                fs.writeFileSync(personalityPath, TEMPLATES.PERSONALITY, 'utf-8');
            }

            this.initialized = true;
            console.log(`[TransparentMemory] Initialized at ${this.basePath}`);
        } catch (err) {
            console.error('[TransparentMemory] Initialization failed:', err);
        }
    }

    async writeGlobalMemory(type: string, content: string): Promise<void> {
        const filePath = path.join(this.basePath, 'global', `${type}.md`);
        await fs.promises.writeFile(filePath, content, 'utf-8');
        console.log(`[TransparentMemory] Wrote global memory: ${type}`);
    }

    async readGlobalMemory(type: string): Promise<string> {
        const filePath = path.join(this.basePath, 'global', `${type}.md`);
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf-8');
        }
        return '';
    }

    async writeUserMemory(userId: string, type: string, content: string): Promise<void> {
        const userDir = path.join(this.basePath, 'users', this.sanitizeUserId(userId));
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }
        const filePath = path.join(userDir, `${type}.md`);
        await fs.promises.writeFile(filePath, content, 'utf-8');
        console.log(`[TransparentMemory] Wrote user memory: ${userId}/${type}`);
    }

    async readUserMemory(userId: string, type: string): Promise<string> {
        const filePath = path.join(this.basePath, 'users', this.sanitizeUserId(userId), `${type}.md`);
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf-8');
        }
        return '';
    }

    async loadAllMemory(userId?: string): Promise<string> {
        const memories: string[] = [];

        const personality = await this.readGlobalMemory('PERSONALITY');
        if (personality) {
            memories.push(personality);
        }

        const knowledge = await this.readGlobalMemory('KNOWLEDGE');
        if (knowledge) {
            memories.push(knowledge);
        }

        if (userId) {
            const profile = await this.readUserMemory(userId, 'PROFILE');
            if (profile) {
                memories.push(profile);
            }

            const preferences = await this.readUserMemory(userId, 'PREFERENCES');
            if (preferences) {
                memories.push(preferences);
            }
        }

        return memories.join('\n\n---\n\n');
    }

    async generateUserProfile(userId: string, facts: Fact[]): Promise<string> {
        const preferences = facts
            .filter(f => f.category === 'preference')
            .map(f => `- ${f.content}`)
            .join('\n') || '- 暂无记录';

        const events = facts
            .filter(f => f.category === 'event')
            .map(f => `- ${f.content}`)
            .join('\n') || '- 暂无记录';

        const relationships = facts
            .filter(f => f.category === 'relationship')
            .map(f => `- ${f.content}`)
            .join('\n') || '- 暂无记录';

        const profile = TEMPLATES.PROFILE
            .replace('{userId}', userId)
            .replace('{firstSeen}', new Date().toISOString().slice(0, 10))
            .replace('{interactionCount}', facts.length.toString())
            .replace('{preferences}', preferences)
            .replace('{events}', events)
            .replace('{relationships}', relationships);

        return profile;
    }

    async syncFromMem0(userId: string, facts: Fact[]): Promise<void> {
        const profile = await this.generateUserProfile(userId, facts);
        await this.writeUserMemory(userId, 'PROFILE', profile);

        const preferences = facts
            .filter(f => f.category === 'preference')
            .map(f => `# 偏好\n\n${f.content}\n\n来源: ${f.source}\n更新时间: ${f.updatedAt}`)
            .join('\n\n---\n\n');

        if (preferences) {
            await this.writeUserMemory(userId, 'PREFERENCES', `# 偏好\n\n${preferences}`);
        }

        console.log(`[TransparentMemory] Synced ${facts.length} facts for user ${userId}`);
    }

    async writeSessionSummary(summary: SessionSummary): Promise<void> {
        const content = TEMPLATES.SESSION
            .replace('{date}', summary.date)
            .replace('{messageCount}', summary.messageCount.toString())
            .replace('{activeUsers}', summary.activeUsers.slice(0, 5).join(', ') || '无')
            .replace('{topics}', summary.topics.map(t => `- ${t}`).join('\n') || '- 无')
            .replace('{interactions}', summary.interactions.map(i => `- ${i}`).join('\n') || '- 无')
            .replace('{learnings}', summary.learnings.map(l => `- ${l}`).join('\n') || '- 无');

        const filePath = path.join(this.basePath, 'sessions', `${summary.date}.md`);
        await fs.promises.writeFile(filePath, content, 'utf-8');
        console.log(`[TransparentMemory] Wrote session summary: ${summary.date}`);
    }

    listMemoryFiles(): { global: string[]; users: string[]; sessions: string[] } {
        const result = {
            global: [] as string[],
            users: [] as string[],
            sessions: [] as string[],
        };

        const globalDir = path.join(this.basePath, 'global');
        if (fs.existsSync(globalDir)) {
            result.global = fs.readdirSync(globalDir).filter(f => f.endsWith('.md'));
        }

        const usersDir = path.join(this.basePath, 'users');
        if (fs.existsSync(usersDir)) {
            result.users = fs.readdirSync(usersDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
        }

        const sessionsDir = path.join(this.basePath, 'sessions');
        if (fs.existsSync(sessionsDir)) {
            result.sessions = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.md'));
        }

        return result;
    }

    private sanitizeUserId(userId: string): string {
        return userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    }

    getStats(): {
        initialized: boolean;
        basePath: string;
        globalFiles: number;
        userCount: number;
        sessionCount: number;
    } {
        const files = this.listMemoryFiles();
        return {
            initialized: this.initialized,
            basePath: this.basePath,
            globalFiles: files.global.length,
            userCount: files.users.length,
            sessionCount: files.sessions.length,
        };
    }
}

let instance: TransparentMemory | null = null;

export function getTransparentMemory(): TransparentMemory {
    if (!instance) {
        instance = new TransparentMemory();
    }
    return instance;
}
