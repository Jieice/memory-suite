/**
 * FallbackManager for ServiceOrchestrator
 * 
 * Implements comprehensive fallback mechanisms for service failures:
 * - Rule-based fallback for DecisionService failures
 * - Template-based fallback for GenerationService failures
 * - Emergency fallback responses for total system failures
 * 
 * Requirements: 8.3 - Graceful degradation with appropriate fallback responses
 */

import { DecisionResponse, GenerationResponse } from './ServiceOrchestrator';

// ============================================
// Types
// ============================================

export type FallbackLevel = 'primary' | 'secondary' | 'emergency';

export interface FallbackConfig {
  /** Enable/disable fallback mechanisms */
  enabled: boolean;
  /** Maximum time to wait before using fallback (ms) */
  timeoutMs: number;
  /** Log fallback usage for monitoring */
  logFallbacks: boolean;
  /** Custom fallback templates */
  customTemplates?: FallbackTemplates;
}

export interface FallbackTemplates {
  decision?: Partial<DecisionFallbackTemplates>;
  generation?: Partial<GenerationFallbackTemplates>;
  emergency?: string[];
}

export interface DecisionFallbackTemplates {
  behaviors: string[];
  themes: string[];
  defaultTone: { verbosity: number; sarcasm: number; warmth: number };
  defaultStyle: { formality: number; creativity: number; engagement: number };
}

export interface GenerationFallbackTemplates {
  greeting: string[];
  acknowledgment: string[];
  confusion: string[];
  farewell: string[];
  error: string[];
  busy: string[];
}

export interface FallbackResult<T> {
  success: boolean;
  data: T;
  fallbackLevel: FallbackLevel;
  fallbackReason: string;
  timestamp: Date;
}

export interface FallbackStats {
  totalFallbacks: number;
  decisionFallbacks: number;
  generationFallbacks: number;
  emergencyFallbacks: number;
  lastFallbackTime: Date | null;
  fallbacksByReason: Map<string, number>;
}

// ============================================
// Default Templates
// ============================================

const DEFAULT_DECISION_TEMPLATES: DecisionFallbackTemplates = {
  behaviors: [
    'reply_friendly',
    'reply_supportive', 
    'reply_playful',
    'clarify_question',
    'emotional_resonate'
  ],
  themes: [
    'friendly_conversation',
    'supportive_response',
    'casual_chat',
    'helpful_assistance'
  ],
  defaultTone: { verbosity: 0.5, sarcasm: 0.1, warmth: 0.7 },
  defaultStyle: { formality: 0.3, creativity: 0.5, engagement: 0.7 }
};

const DEFAULT_GENERATION_TEMPLATES: GenerationFallbackTemplates = {
  greeting: [
    '你好呀！很高兴见到你~',
    '嗨嗨！有什么我可以帮你的吗？',
    '哈喽！今天过得怎么样？'
  ],
  acknowledgment: [
    '嗯嗯，我听到了~',
    '好的好的~',
    '收到啦！',
    '明白了！',
    '了解~'
  ],
  confusion: [
    '抱歉，我没太明白你的意思，能再说一遍吗？',
    '嗯...我有点困惑，你能解释一下吗？',
    '不好意思，我没听懂，能换个说法吗？'
  ],
  farewell: [
    '拜拜！下次再聊~',
    '再见啦！',
    '好的，下次见！'
  ],
  error: [
    '抱歉，我现在有点忙，稍后再聊好吗？',
    '不好意思，我这边出了点小问题，等我一下~',
    '哎呀，我需要休息一下，马上回来！'
  ],
  busy: [
    '稍等一下哦，我正在处理中~',
    '请稍候，马上就好！',
    '等我一下下~'
  ]
};

const DEFAULT_EMERGENCY_RESPONSES: string[] = [
  '系统正在维护中，请稍后再试。',
  '服务暂时不可用，我们正在努力恢复。',
  '抱歉，当前无法处理您的请求，请稍后重试。'
];

// ============================================
// FallbackManager Class
// ============================================

export class FallbackManager {
  private config: FallbackConfig;
  private decisionTemplates: DecisionFallbackTemplates;
  private generationTemplates: GenerationFallbackTemplates;
  private emergencyResponses: string[];
  private stats: FallbackStats;

  constructor(config?: Partial<FallbackConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      timeoutMs: config?.timeoutMs ?? 5000,
      logFallbacks: config?.logFallbacks ?? true,
      customTemplates: config?.customTemplates
    };

    // Merge custom templates with defaults
    this.decisionTemplates = {
      ...DEFAULT_DECISION_TEMPLATES,
      ...config?.customTemplates?.decision
    };

    this.generationTemplates = {
      ...DEFAULT_GENERATION_TEMPLATES,
      ...config?.customTemplates?.generation
    };

    this.emergencyResponses = config?.customTemplates?.emergency || DEFAULT_EMERGENCY_RESPONSES;

    // Initialize stats
    this.stats = {
      totalFallbacks: 0,
      decisionFallbacks: 0,
      generationFallbacks: 0,
      emergencyFallbacks: 0,
      lastFallbackTime: null,
      fallbacksByReason: new Map()
    };
  }

  /**
   * Check if fallback is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Enable or disable fallback mechanisms
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * Get rule-based fallback decision when DecisionService fails
   */
  getDecisionFallback(
    userMessage: string,
    reason: string = 'service_unavailable'
  ): FallbackResult<DecisionResponse> {
    this.recordFallback('decision', reason);

    const behavior = this.selectBehaviorFromMessage(userMessage);
    const theme = this.selectThemeFromMessage(userMessage);

    const fallbackDecision: DecisionResponse = {
      success: true,
      selectedBehavior: {
        type: behavior,
        confidence: 0.5,
        reasoning: `Fallback decision: ${reason}`
      },
      creativeGuidance: {
        theme,
        keyPoints: this.extractKeyPoints(userMessage),
        tone: { ...this.decisionTemplates.defaultTone },
        style: { ...this.decisionTemplates.defaultStyle },
        constraints: {
          maxLength: 200,
          forbiddenTopics: [],
          requiredElements: []
        }
      },
      proactiveBehaviors: {
        continueConversation: 0.5,
        respondToDanmaku: 0.5,
        initiateSpeak: 0.1,
        playMedia: 0.05,
        privateMessage: 0.02,
        doNothing: 0.1
      },
      metadata: {
        processingTime: 0,
        nnConfidence: 0.5,
        ruleWeight: 1.0,
        fallbackUsed: true
      }
    };

    if (this.config.logFallbacks) {
      console.log(`[FallbackManager] Decision fallback used: ${reason}`);
    }

    return {
      success: true,
      data: fallbackDecision,
      fallbackLevel: 'primary',
      fallbackReason: reason,
      timestamp: new Date()
    };
  }

  /**
   * Get template-based fallback response when GenerationService fails
   */
  getGenerationFallback(
    userMessage: string,
    decision: DecisionResponse | null,
    reason: string = 'service_unavailable'
  ): FallbackResult<GenerationResponse> {
    this.recordFallback('generation', reason);

    const responseText = this.selectTemplateResponse(userMessage, decision);

    const fallbackGeneration: GenerationResponse = {
      success: true,
      text: responseText,
      metadata: {
        processingTime: 0,
        tokenCount: responseText.length,
        model: 'fallback-template',
        temperature: 0,
        guidanceFollowed: false,
        fallbackUsed: true,
        retryCount: 0
      },
      quality: {
        coherence: 0.7,
        relevance: 0.5,
        creativity: 0.3,
        safety: 1.0
      }
    };

    if (this.config.logFallbacks) {
      console.log(`[FallbackManager] Generation fallback used: ${reason}`);
    }

    return {
      success: true,
      data: fallbackGeneration,
      fallbackLevel: 'secondary',
      fallbackReason: reason,
      timestamp: new Date()
    };
  }

  /**
   * Get emergency fallback response when both services fail
   */
  getEmergencyFallback(reason: string = 'total_system_failure'): FallbackResult<string> {
    this.recordFallback('emergency', reason);

    const responseText = this.selectEmergencyResponse();

    if (this.config.logFallbacks) {
      console.error(`[FallbackManager] EMERGENCY fallback used: ${reason}`);
    }

    return {
      success: true,
      data: responseText,
      fallbackLevel: 'emergency',
      fallbackReason: reason,
      timestamp: new Date()
    };
  }

  /**
   * Select appropriate behavior based on message content
   */
  private selectBehaviorFromMessage(message: string): string {
    const lowerMessage = message.toLowerCase();

    // Question detection
    if (message.includes('?') || message.includes('？') ||
        lowerMessage.includes('什么') || lowerMessage.includes('怎么') ||
        lowerMessage.includes('为什么') || lowerMessage.includes('哪')) {
      return 'clarify_question';
    }

    // Emotional content detection
    if (lowerMessage.includes('难过') || lowerMessage.includes('伤心') ||
        lowerMessage.includes('开心') || lowerMessage.includes('高兴') ||
        lowerMessage.includes('生气') || lowerMessage.includes('烦')) {
      return 'emotional_resonate';
    }

    // Greeting detection
    if (lowerMessage.includes('你好') || lowerMessage.includes('嗨') ||
        lowerMessage.includes('hello') || lowerMessage.includes('hi')) {
      return 'reply_friendly';
    }

    // Support request detection
    if (lowerMessage.includes('帮') || lowerMessage.includes('help') ||
        lowerMessage.includes('请') || lowerMessage.includes('能不能')) {
      return 'reply_supportive';
    }

    // Default to friendly reply
    const behaviors = this.decisionTemplates.behaviors;
    return behaviors[this.hashString(message) % behaviors.length];
  }

  /**
   * Select appropriate theme based on message content
   */
  private selectThemeFromMessage(message: string): string {
    const themes = this.decisionTemplates.themes;
    return themes[this.hashString(message) % themes.length];
  }

  /**
   * Extract key points from user message
   */
  private extractKeyPoints(message: string): string[] {
    const keyPoints: string[] = ['engage_with_user'];

    if (message.includes('?') || message.includes('？')) {
      keyPoints.push('answer_question');
    }

    if (message.length > 50) {
      keyPoints.push('acknowledge_detail');
    }

    return keyPoints;
  }

  /**
   * Select template response based on message and decision context
   */
  private selectTemplateResponse(
    userMessage: string,
    decision: DecisionResponse | null
  ): string {
    const lowerMessage = userMessage.toLowerCase();
    const templates = this.generationTemplates;

    // Greeting response
    if (lowerMessage.includes('你好') || lowerMessage.includes('嗨') ||
        lowerMessage.includes('hello') || lowerMessage.includes('hi')) {
      return this.selectFromArray(templates.greeting, userMessage);
    }

    // Farewell response
    if (lowerMessage.includes('再见') || lowerMessage.includes('拜拜') ||
        lowerMessage.includes('bye') || lowerMessage.includes('晚安')) {
      return this.selectFromArray(templates.farewell, userMessage);
    }

    // Question - show confusion if we can't properly answer
    if (userMessage.includes('?') || userMessage.includes('？')) {
      // If decision suggests we should clarify, use confusion template
      if (decision?.selectedBehavior?.type === 'clarify_question') {
        return this.selectFromArray(templates.confusion, userMessage);
      }
    }

    // Default to acknowledgment
    return this.selectFromArray(templates.acknowledgment, userMessage);
  }

  /**
   * Select emergency response
   */
  private selectEmergencyResponse(): string {
    const index = Math.floor(Math.random() * this.emergencyResponses.length);
    return this.emergencyResponses[index];
  }

  /**
   * Select from array using message hash for consistency
   */
  private selectFromArray(arr: string[], seed: string): string {
    const index = this.hashString(seed) % arr.length;
    return arr[index];
  }

  /**
   * Simple string hash for consistent selection
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Record fallback usage for statistics
   */
  private recordFallback(type: 'decision' | 'generation' | 'emergency', reason: string): void {
    this.stats.totalFallbacks++;
    this.stats.lastFallbackTime = new Date();

    switch (type) {
      case 'decision':
        this.stats.decisionFallbacks++;
        break;
      case 'generation':
        this.stats.generationFallbacks++;
        break;
      case 'emergency':
        this.stats.emergencyFallbacks++;
        break;
    }

    const currentCount = this.stats.fallbacksByReason.get(reason) || 0;
    this.stats.fallbacksByReason.set(reason, currentCount + 1);
  }

  /**
   * Get fallback statistics
   */
  getStats(): FallbackStats {
    return {
      ...this.stats,
      fallbacksByReason: new Map(this.stats.fallbacksByReason)
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalFallbacks: 0,
      decisionFallbacks: 0,
      generationFallbacks: 0,
      emergencyFallbacks: 0,
      lastFallbackTime: null,
      fallbacksByReason: new Map()
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): FallbackConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<FallbackConfig>): void {
    this.config = { ...this.config, ...newConfig };

    if (newConfig.customTemplates?.decision) {
      this.decisionTemplates = {
        ...this.decisionTemplates,
        ...newConfig.customTemplates.decision
      };
    }

    if (newConfig.customTemplates?.generation) {
      this.generationTemplates = {
        ...this.generationTemplates,
        ...newConfig.customTemplates.generation
      };
    }

    if (newConfig.customTemplates?.emergency) {
      this.emergencyResponses = newConfig.customTemplates.emergency;
    }
  }

  /**
   * Add custom generation template
   */
  addGenerationTemplate(
    category: keyof GenerationFallbackTemplates,
    template: string
  ): void {
    if (!this.generationTemplates[category]) {
      this.generationTemplates[category] = [];
    }
    this.generationTemplates[category].push(template);
  }

  /**
   * Add custom decision behavior
   */
  addDecisionBehavior(behavior: string): void {
    if (!this.decisionTemplates.behaviors.includes(behavior)) {
      this.decisionTemplates.behaviors.push(behavior);
    }
  }
}

// Export singleton instance
export const fallbackManager = new FallbackManager();
