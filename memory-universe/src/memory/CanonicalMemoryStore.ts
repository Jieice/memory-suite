import fs from 'fs';
import path from 'path';

export type PreferenceSentiment = 'like' | 'dislike' | 'prefer' | 'avoid';

export interface CanonicalPreference {
    topic: string;
    sentiment: PreferenceSentiment;
    confidence: number;
    volatile: boolean;
    sourceText?: string;
    updatedAt: number;
}

export interface CanonicalTask {
    text: string;
    status: 'open' | 'done';
    confidence: number;
    source: 'creator' | 'viewer';
    updatedAt: number;
}

export interface CanonicalConflict {
    kind: 'name' | 'fact' | 'preference' | 'task';
    previous: string;
    incoming: string;
    detail: string;
    detectedAt: number;
    resolved: boolean;
}

export interface CanonicalUserMemory {
    userId: string;
    preferredName?: string;
    facts: string[];
    preferences: CanonicalPreference[];
    tasks: CanonicalTask[];
    conflicts: CanonicalConflict[];
    interactionCount: number;
    updatedAt: number;
}

type CanonicalStoreFile = {
    version: number;
    savedAt: number;
    users: Record<string, CanonicalUserMemory>;
};

export interface CanonicalMemoryStoreConfig {
    filePath: string;
    maxFactsPerUser: number;
    maxPreferencesPerUser: number;
    maxTasksPerUser: number;
    maxConflictsPerUser: number;
    volatilePreferenceTtlMs: number;
}

const DEFAULT_CONFIG: CanonicalMemoryStoreConfig = {
    filePath: path.resolve(process.cwd(), '..', 'data', 'canonical-memory.json'),
    maxFactsPerUser: 16,
    maxPreferencesPerUser: 24,
    maxTasksPerUser: 16,
    maxConflictsPerUser: 24,
    volatilePreferenceTtlMs: 14 * 24 * 60 * 60 * 1000
};

export class CanonicalMemoryStore {
    private readonly config: CanonicalMemoryStoreConfig;
    private readonly users = new Map<string, CanonicalUserMemory>();
    private dirty = false;
    private saveTimer: NodeJS.Timeout | null = null;

    constructor(config: Partial<CanonicalMemoryStoreConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.ensureDir();
        this.load();
    }

    private ensureDir(): void {
        const dir = path.dirname(this.config.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    private normalizeUserId(userId: string): string {
        const key = (userId || '').trim();
        return key || 'anonymous';
    }

    private clampConfidence(value: number, fallback = 0.6): number {
        if (!Number.isFinite(value)) return fallback;
        return Math.max(0, Math.min(1, value));
    }

    private normalizeTopic(value: string): string {
        return (value || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 60);
    }

    private pruneUser(user: CanonicalUserMemory): void {
        const now = Date.now();
        const beforePrefs = user.preferences.length;
        user.preferences = user.preferences
            .filter((pref) => {
                if (!pref.volatile) return true;
                return now - pref.updatedAt <= this.config.volatilePreferenceTtlMs;
            })
            .slice(-this.config.maxPreferencesPerUser);

        user.tasks = user.tasks
            .slice(-this.config.maxTasksPerUser)
            .sort((a, b) => {
                if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
                return b.updatedAt - a.updatedAt;
            });

        user.conflicts = user.conflicts
            .slice(-this.config.maxConflictsPerUser)
            .sort((a, b) => b.detectedAt - a.detectedAt);

        if (user.facts.length > this.config.maxFactsPerUser) {
            user.facts = user.facts.slice(user.facts.length - this.config.maxFactsPerUser);
        }

        if (user.preferences.length !== beforePrefs) {
            user.updatedAt = now;
            this.dirty = true;
        }
    }

    private load(): void {
        if (!fs.existsSync(this.config.filePath)) {
            return;
        }
        try {
            const raw = fs.readFileSync(this.config.filePath, 'utf-8');
            const parsed = JSON.parse(raw) as CanonicalStoreFile;
            const entries = Object.entries(parsed.users || {});
            for (const [userId, value] of entries) {
                const rawPreferences = Array.isArray(value.preferences) ? value.preferences : [];
                const rawTasks = Array.isArray(value.tasks) ? value.tasks : [];
                const rawConflicts = Array.isArray(value.conflicts) ? value.conflicts : [];
                this.users.set(userId, {
                    userId,
                    preferredName: value.preferredName,
                    facts: Array.isArray(value.facts) ? value.facts : [],
                    preferences: rawPreferences
                        .map((pref): CanonicalPreference => {
                            const sentiment: PreferenceSentiment = (
                                pref?.sentiment === 'dislike' ||
                                pref?.sentiment === 'prefer' ||
                                pref?.sentiment === 'avoid'
                            )
                                ? pref.sentiment
                                : 'like';
                            return {
                                topic: this.normalizeTopic(pref?.topic || ''),
                                sentiment,
                                confidence: this.clampConfidence(Number(pref?.confidence), 0.6),
                                volatile: pref?.volatile !== false,
                                sourceText: typeof pref?.sourceText === 'string' ? pref.sourceText.slice(0, 120) : undefined,
                                updatedAt: Number.isFinite(pref?.updatedAt) ? Number(pref.updatedAt) : Date.now()
                            };
                        })
                        .filter((pref) => !!pref.topic),
                    tasks: rawTasks
                        .map((task): CanonicalTask => {
                            const status: CanonicalTask['status'] = task?.status === 'done' ? 'done' : 'open';
                            const source: CanonicalTask['source'] = task?.source === 'creator' ? 'creator' : 'viewer';
                            return {
                                text: (task?.text || '').toString().trim().slice(0, 120),
                                status,
                                confidence: this.clampConfidence(Number(task?.confidence), 0.6),
                                source,
                                updatedAt: Number.isFinite(task?.updatedAt) ? Number(task.updatedAt) : Date.now()
                            };
                        })
                        .filter((task) => !!task.text),
                    conflicts: rawConflicts
                        .map((conflict): CanonicalConflict => {
                            const kind: CanonicalConflict['kind'] = (
                                conflict?.kind === 'fact' ||
                                conflict?.kind === 'preference' ||
                                conflict?.kind === 'task'
                            )
                                ? conflict.kind
                                : 'name';
                            return {
                                kind,
                                previous: (conflict?.previous || '').toString().slice(0, 160),
                                incoming: (conflict?.incoming || '').toString().slice(0, 160),
                                detail: (conflict?.detail || '').toString().slice(0, 200),
                                detectedAt: Number.isFinite(conflict?.detectedAt) ? Number(conflict.detectedAt) : Date.now(),
                                resolved: conflict?.resolved === true
                            };
                        })
                        .filter((conflict) => !!conflict.previous || !!conflict.incoming),
                    interactionCount: Number.isFinite(value.interactionCount) ? value.interactionCount : 0,
                    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now()
                });
                const loaded = this.users.get(userId);
                if (loaded) {
                    this.pruneUser(loaded);
                }
            }
            console.log(`[CanonicalMemory] Loaded ${this.users.size} users from ${this.config.filePath}`);
        } catch (error: any) {
            console.error(`[CanonicalMemory] Failed to load store: ${error?.message || error}`);
        }
    }

    private scheduleSave(): void {
        this.dirty = true;
        if (this.saveTimer) return;
        const saveInterval = parseInt(process.env.CANONICAL_MEMORY_SAVE_INTERVAL_MS || '500', 10);
        this.saveTimer = setTimeout(() => {
            this.saveNow();
            this.saveTimer = null;
        }, Math.max(200, saveInterval));
    }

    forceSave(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.saveNow();
    }

    private saveNow(): void {
        if (!this.dirty) return;
        const payload: CanonicalStoreFile = {
            version: 1,
            savedAt: Date.now(),
            users: Object.fromEntries(this.users.entries())
        };
        try {
            fs.writeFileSync(this.config.filePath, JSON.stringify(payload, null, 2), 'utf-8');
            this.dirty = false;
        } catch (error: any) {
            console.error(`[CanonicalMemory] Failed to save store: ${error?.message || error}`);
        }
    }

    private getOrCreate(userId: string): CanonicalUserMemory {
        const key = this.normalizeUserId(userId);
        const current = this.users.get(key);
        if (current) return current;
        const created: CanonicalUserMemory = {
            userId: key,
            facts: [],
            preferences: [],
            tasks: [],
            conflicts: [],
            interactionCount: 0,
            updatedAt: Date.now()
        };
        this.users.set(key, created);
        return created;
    }

    touchInteraction(userId: string): void {
        const user = this.getOrCreate(userId);
        user.interactionCount += 1;
        user.updatedAt = Date.now();
        this.scheduleSave();
    }

    setPreferredName(userId: string, preferredName: string): void {
        const name = (preferredName || '').trim();
        if (!name) return;
        const user = this.getOrCreate(userId);
        user.preferredName = name;
        user.updatedAt = Date.now();
        this.scheduleSave();
    }

    addFacts(userId: string, facts: string[]): void {
        const cleanFacts = (facts || [])
            .map((x) => (x || '').trim())
            .filter(Boolean);
        if (cleanFacts.length === 0) return;

        const user = this.getOrCreate(userId);
        const seen = new Set(user.facts.map((x) => x.toLowerCase()));
        for (const fact of cleanFacts) {
            const key = fact.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            user.facts.push(fact);
        }
        if (user.facts.length > this.config.maxFactsPerUser) {
            user.facts = user.facts.slice(user.facts.length - this.config.maxFactsPerUser);
        }
        user.updatedAt = Date.now();
        this.scheduleSave();
    }

    addPreferences(userId: string, preferences: Array<Omit<CanonicalPreference, 'updatedAt'> & { updatedAt?: number }>): void {
        const user = this.getOrCreate(userId);
        const now = Date.now();

        for (const incoming of preferences || []) {
            const topic = this.normalizeTopic(incoming?.topic || '');
            if (!topic) continue;
            const sentiment: PreferenceSentiment = incoming.sentiment === 'dislike'
                ? 'dislike'
                : incoming.sentiment === 'prefer'
                    ? 'prefer'
                    : incoming.sentiment === 'avoid'
                        ? 'avoid'
                        : 'like';
            const confidence = this.clampConfidence(Number(incoming?.confidence), 0.62);
            const updatedAt = Number.isFinite(incoming?.updatedAt) ? Number(incoming.updatedAt) : now;
            const volatile = incoming?.volatile !== false;
            const sourceText = typeof incoming?.sourceText === 'string'
                ? incoming.sourceText.slice(0, 120)
                : undefined;

            const existingIndex = user.preferences.findIndex(
                (pref) => pref.topic.toLowerCase() === topic.toLowerCase()
            );
            const normalizedPref: CanonicalPreference = {
                topic,
                sentiment,
                confidence,
                volatile,
                sourceText,
                updatedAt
            };

            if (existingIndex >= 0) {
                const existing = user.preferences[existingIndex];
                user.preferences[existingIndex] = {
                    ...existing,
                    ...normalizedPref,
                    confidence: Math.max(existing.confidence, confidence),
                    volatile: existing.volatile && volatile
                };
            } else {
                user.preferences.push(normalizedPref);
            }
        }

        this.pruneUser(user);
        user.updatedAt = now;
        this.scheduleSave();
    }

    upsertTasks(userId: string, tasks: Array<Omit<CanonicalTask, 'updatedAt'> & { updatedAt?: number }>): void {
        const user = this.getOrCreate(userId);
        const now = Date.now();

        for (const task of tasks || []) {
            const text = (task?.text || '').toString().trim().slice(0, 120);
            if (!text) continue;
            const status: CanonicalTask['status'] = task?.status === 'done' ? 'done' : 'open';
            const confidence = this.clampConfidence(Number(task?.confidence), 0.62);
            const source: CanonicalTask['source'] = task?.source === 'creator' ? 'creator' : 'viewer';
            const updatedAt = Number.isFinite(task?.updatedAt) ? Number(task.updatedAt) : now;

            const existingIndex = user.tasks.findIndex(
                (item) => item.text.toLowerCase() === text.toLowerCase()
            );
            const normalizedTask: CanonicalTask = {
                text,
                status,
                confidence,
                source,
                updatedAt
            };
            if (existingIndex >= 0) {
                const existing = user.tasks[existingIndex];
                user.tasks[existingIndex] = {
                    ...existing,
                    ...normalizedTask,
                    confidence: Math.max(existing.confidence, confidence)
                };
            } else {
                user.tasks.push(normalizedTask);
            }
        }

        this.pruneUser(user);
        user.updatedAt = now;
        this.scheduleSave();
    }

    addConflict(userId: string, conflict: Omit<CanonicalConflict, 'detectedAt'> & { detectedAt?: number }): void {
        const user = this.getOrCreate(userId);
        const item: CanonicalConflict = {
            kind: (conflict.kind === 'fact' || conflict.kind === 'preference' || conflict.kind === 'task') ? conflict.kind : 'name',
            previous: (conflict.previous || '').toString().slice(0, 160),
            incoming: (conflict.incoming || '').toString().slice(0, 160),
            detail: (conflict.detail || '').toString().slice(0, 200),
            detectedAt: Number.isFinite(conflict.detectedAt) ? Number(conflict.detectedAt) : Date.now(),
            resolved: conflict.resolved === true
        };
        user.conflicts.push(item);
        this.pruneUser(user);
        user.updatedAt = Date.now();
        this.scheduleSave();
    }

    getUser(userId: string): CanonicalUserMemory | undefined {
        const key = this.normalizeUserId(userId);
        const current = this.users.get(key);
        if (!current) return undefined;
        this.pruneUser(current);
        return {
            userId: current.userId,
            preferredName: current.preferredName,
            facts: [...current.facts],
            preferences: current.preferences.map((pref) => ({ ...pref })),
            tasks: current.tasks.map((task) => ({ ...task })),
            conflicts: current.conflicts.map((conflict) => ({ ...conflict })),
            interactionCount: current.interactionCount,
            updatedAt: current.updatedAt
        };
    }

    getStats(): {
        users: number;
        withName: number;
        withFacts: number;
        withPreferences: number;
        withOpenTasks: number;
        withConflicts: number;
        path: string;
    } {
        let withName = 0;
        let withFacts = 0;
        let withPreferences = 0;
        let withOpenTasks = 0;
        let withConflicts = 0;
        for (const user of this.users.values()) {
            if (user.preferredName) withName += 1;
            if (user.facts.length > 0) withFacts += 1;
            if (user.preferences.length > 0) withPreferences += 1;
            if (user.tasks.some((task) => task.status === 'open')) withOpenTasks += 1;
            if (user.conflicts.length > 0) withConflicts += 1;
        }
        return {
            users: this.users.size,
            withName,
            withFacts,
            withPreferences,
            withOpenTasks,
            withConflicts,
            path: this.config.filePath
        };
    }

    dispose(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.saveNow();
    }
}
