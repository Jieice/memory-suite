/**
 * GracefulDegradation for ServiceOrchestrator
 * 
 * Implements graceful degradation strategies when services are unavailable:
 * - Partial functionality when services are unavailable
 * - Priority-based request handling
 * - Clear user communication about limited capabilities
 * 
 * Requirements: 8.3 - Graceful degradation with appropriate fallback responses
 */

import { FallbackManager, FallbackResult } from './FallbackManager';
import { 
  DecisionResponse, 
  GenerationResponse, 
  ChatResponse,
  ServiceHealth 
} from './ServiceOrchestrator';

// ============================================
// Types
// ============================================

export type DegradationLevel = 'full' | 'partial' | 'minimal' | 'emergency';
export type RequestPriority = 'critical' | 'high' | 'normal' | 'low';

export interface DegradationConfig {
  /** Enable graceful degradation */
  enabled: boolean;
  /** Maximum queue size for low priority requests */
  maxQueueSize: number;
  /** Timeout for queued requests (ms) */
  queueTimeoutMs: number;
  /** Enable user notifications about degraded state */
  notifyUsers: boolean;
  /** Custom degradation messages */
  messages?: DegradationMessages;
}

export interface DegradationMessages {
  partialService: string;
  minimalService: string;
  emergencyMode: string;
  queuedRequest: string;
  serviceRestored: string;
}

export interface DegradationState {
  level: DegradationLevel;
  availableServices: string[];
  unavailableServices: string[];
  capabilities: ServiceCapabilities;
  lastStateChange: Date;
  reason: string;
}

export interface ServiceCapabilities {
  canProcessChat: boolean;
  canMakeDecisions: boolean;
  canGenerateText: boolean;
  canCheckProactive: boolean;
  usingFallbacks: boolean;
  limitedFeatures: string[];
}

export interface QueuedRequest {
  id: string;
  priority: RequestPriority;
  type: 'chat' | 'decision' | 'generation' | 'proactive';
  data: unknown;
  timestamp: Date;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface DegradationStats {
  currentLevel: DegradationLevel;
  totalDegradedRequests: number;
  queuedRequests: number;
  droppedRequests: number;
  averageResponseTime: number;
  lastLevelChange: Date | null;
  levelHistory: Array<{ level: DegradationLevel; timestamp: Date; reason: string }>;
}

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: DegradationConfig = {
  enabled: true,
  maxQueueSize: 100,
  queueTimeoutMs: 30000,
  notifyUsers: true,
  messages: {
    partialService: '部分功能暂时受限，但我仍然可以帮助你~',
    minimalService: '服务正在恢复中，功能可能有限。',
    emergencyMode: '系统正在维护，请稍后再试。',
    queuedRequest: '请求已排队，请稍候...',
    serviceRestored: '服务已恢复正常！'
  }
};

const DEFAULT_MESSAGES: DegradationMessages = {
  partialService: '部分功能暂时受限，但我仍然可以帮助你~',
  minimalService: '服务正在恢复中，功能可能有限。',
  emergencyMode: '系统正在维护，请稍后再试。',
  queuedRequest: '请求已排队，请稍候...',
  serviceRestored: '服务已恢复正常！'
};

// ============================================
// GracefulDegradation Class
// ============================================

export class GracefulDegradation {
  private config: DegradationConfig;
  private messages: DegradationMessages;
  private fallbackManager: FallbackManager;
  private currentState: DegradationState;
  private requestQueue: QueuedRequest[] = [];
  private stats: DegradationStats;
  private queueProcessorTimer: NodeJS.Timeout | null = null;

  constructor(
    fallbackManager: FallbackManager,
    config?: Partial<DegradationConfig>
  ) {
    this.fallbackManager = fallbackManager;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.messages = { ...DEFAULT_MESSAGES, ...config?.messages };

    // Initialize state
    this.currentState = {
      level: 'full',
      availableServices: ['decision', 'generation'],
      unavailableServices: [],
      capabilities: {
        canProcessChat: true,
        canMakeDecisions: true,
        canGenerateText: true,
        canCheckProactive: true,
        usingFallbacks: false,
        limitedFeatures: []
      },
      lastStateChange: new Date(),
      reason: 'initial'
    };

    // Initialize stats
    this.stats = {
      currentLevel: 'full',
      totalDegradedRequests: 0,
      queuedRequests: 0,
      droppedRequests: 0,
      averageResponseTime: 0,
      lastLevelChange: null,
      levelHistory: []
    };
  }

  /**
   * Update degradation state based on service health
   */
  updateState(serviceHealth: Map<string, ServiceHealth>): DegradationState {
    const decisionHealth = serviceHealth.get('decision');
    const generationHealth = serviceHealth.get('generation');

    const decisionAvailable = decisionHealth?.status === 'healthy' || 
                              decisionHealth?.status === 'degraded';
    const generationAvailable = generationHealth?.status === 'healthy' || 
                                generationHealth?.status === 'degraded';

    const availableServices: string[] = [];
    const unavailableServices: string[] = [];

    if (decisionAvailable) {
      availableServices.push('decision');
    } else {
      unavailableServices.push('decision');
    }

    if (generationAvailable) {
      availableServices.push('generation');
    } else {
      unavailableServices.push('generation');
    }

    // Determine degradation level
    let level: DegradationLevel;
    let reason: string;

    if (decisionAvailable && generationAvailable) {
      level = 'full';
      reason = 'all_services_available';
    } else if (decisionAvailable || generationAvailable) {
      level = 'partial';
      reason = `${unavailableServices.join(', ')} unavailable`;
    } else {
      level = 'emergency';
      reason = 'all_services_unavailable';
    }

    // Check if level changed
    if (level !== this.currentState.level) {
      this.recordLevelChange(level, reason);
    }

    // Update capabilities
    const capabilities: ServiceCapabilities = {
      canProcessChat: decisionAvailable || generationAvailable || this.fallbackManager.isEnabled(),
      canMakeDecisions: decisionAvailable || this.fallbackManager.isEnabled(),
      canGenerateText: generationAvailable || this.fallbackManager.isEnabled(),
      canCheckProactive: decisionAvailable,
      usingFallbacks: !decisionAvailable || !generationAvailable,
      limitedFeatures: this.determineLimitedFeatures(decisionAvailable, generationAvailable)
    };

    this.currentState = {
      level,
      availableServices,
      unavailableServices,
      capabilities,
      lastStateChange: new Date(),
      reason
    };

    this.stats.currentLevel = level;

    return this.currentState;
  }

  /**
   * Determine which features are limited
   */
  private determineLimitedFeatures(
    decisionAvailable: boolean,
    generationAvailable: boolean
  ): string[] {
    const limited: string[] = [];

    if (!decisionAvailable) {
      limited.push('intelligent_decisions');
      limited.push('proactive_behaviors');
      limited.push('context_awareness');
    }

    if (!generationAvailable) {
      limited.push('natural_language_generation');
      limited.push('creative_responses');
      limited.push('personalized_content');
    }

    return limited;
  }

  /**
   * Record level change for history
   */
  private recordLevelChange(level: DegradationLevel, reason: string): void {
    this.stats.lastLevelChange = new Date();
    this.stats.levelHistory.push({
      level,
      timestamp: new Date(),
      reason
    });

    // Keep only last 100 entries
    if (this.stats.levelHistory.length > 100) {
      this.stats.levelHistory = this.stats.levelHistory.slice(-100);
    }

    if (this.config.notifyUsers) {
      console.log(`[GracefulDegradation] Level changed: ${this.currentState.level} → ${level} (${reason})`);
    }
  }

  /**
   * Get current degradation state
   */
  getState(): DegradationState {
    return { ...this.currentState };
  }

  /**
   * Get current degradation level
   */
  getLevel(): DegradationLevel {
    return this.currentState.level;
  }

  /**
   * Check if a capability is available
   */
  hasCapability(capability: keyof ServiceCapabilities): boolean {
    return this.currentState.capabilities[capability] as boolean;
  }

  /**
   * Get user-friendly status message
   */
  getStatusMessage(): string {
    switch (this.currentState.level) {
      case 'full':
        return '';
      case 'partial':
        return this.messages.partialService;
      case 'minimal':
        return this.messages.minimalService;
      case 'emergency':
        return this.messages.emergencyMode;
      default:
        return '';
    }
  }

  /**
   * Process chat request with graceful degradation
   */
  async processChatWithDegradation(
    userMessage: string,
    userId: string,
    processDecision: () => Promise<DecisionResponse>,
    processGeneration: (decision: DecisionResponse) => Promise<GenerationResponse>,
    priority: RequestPriority = 'normal'
  ): Promise<ChatResponse> {
    const startTime = Date.now();
    const servicesUsed: string[] = [];
    let fallbackUsed = false;

    // Check if we should queue low priority requests during degradation
    if (this.currentState.level !== 'full' && priority === 'low') {
      if (this.requestQueue.length >= this.config.maxQueueSize) {
        this.stats.droppedRequests++;
        return {
          success: false,
          error: 'Request dropped due to high load',
          metadata: {
            decisionTime: 0,
            generationTime: 0,
            totalTime: Date.now() - startTime,
            fallbackUsed: false,
            servicesUsed: []
          }
        };
      }
    }

    // Emergency mode - use emergency fallback
    if (this.currentState.level === 'emergency') {
      this.stats.totalDegradedRequests++;
      const emergencyFallback = this.fallbackManager.getEmergencyFallback('emergency_mode');
      
      return {
        success: true,
        text: emergencyFallback.data,
        metadata: {
          decisionTime: 0,
          generationTime: 0,
          totalTime: Date.now() - startTime,
          fallbackUsed: true,
          servicesUsed: ['fallback']
        }
      };
    }

    // Try to get decision
    let decision: DecisionResponse;
    const decisionStartTime = Date.now();

    if (this.currentState.capabilities.canMakeDecisions && 
        this.currentState.availableServices.includes('decision')) {
      try {
        decision = await processDecision();
        if (decision.success) {
          servicesUsed.push('DecisionService');
        } else {
          throw new Error(decision.error?.message || 'Decision failed');
        }
      } catch (error) {
        // Use fallback decision
        this.stats.totalDegradedRequests++;
        const fallbackResult = this.fallbackManager.getDecisionFallback(
          userMessage,
          'decision_service_error'
        );
        decision = fallbackResult.data;
        fallbackUsed = true;
        servicesUsed.push('DecisionFallback');
      }
    } else {
      // Decision service unavailable, use fallback
      this.stats.totalDegradedRequests++;
      const fallbackResult = this.fallbackManager.getDecisionFallback(
        userMessage,
        'decision_service_unavailable'
      );
      decision = fallbackResult.data;
      fallbackUsed = true;
      servicesUsed.push('DecisionFallback');
    }

    const decisionTime = Date.now() - decisionStartTime;

    // Try to generate response
    let generationResponse: GenerationResponse;
    const generationStartTime = Date.now();

    if (this.currentState.capabilities.canGenerateText && 
        this.currentState.availableServices.includes('generation')) {
      try {
        generationResponse = await processGeneration(decision);
        if (generationResponse.success) {
          servicesUsed.push('GenerationService');
        } else {
          throw new Error(generationResponse.error?.message || 'Generation failed');
        }
      } catch (error) {
        // Use fallback generation
        this.stats.totalDegradedRequests++;
        const fallbackResult = this.fallbackManager.getGenerationFallback(
          userMessage,
          decision,
          'generation_service_error'
        );
        generationResponse = fallbackResult.data;
        fallbackUsed = true;
        servicesUsed.push('GenerationFallback');
      }
    } else {
      // Generation service unavailable, use fallback
      this.stats.totalDegradedRequests++;
      const fallbackResult = this.fallbackManager.getGenerationFallback(
        userMessage,
        decision,
        'generation_service_unavailable'
      );
      generationResponse = fallbackResult.data;
      fallbackUsed = true;
      servicesUsed.push('GenerationFallback');
    }

    const generationTime = Date.now() - generationStartTime;
    const totalTime = Date.now() - startTime;

    // Update average response time
    this.updateAverageResponseTime(totalTime);

    // Add status message if in degraded state
    let responseText = generationResponse.text || '';
    if (this.config.notifyUsers && this.currentState.level !== 'full' && fallbackUsed) {
      const statusMessage = this.getStatusMessage();
      if (statusMessage && !responseText.includes(statusMessage)) {
        // Don't prepend status message to every response, just log it
        console.log(`[GracefulDegradation] Response generated in ${this.currentState.level} mode`);
      }
    }

    return {
      success: true,
      text: responseText,
      metadata: {
        decisionTime,
        generationTime,
        totalTime,
        fallbackUsed,
        servicesUsed
      }
    };
  }

  /**
   * Update average response time
   */
  private updateAverageResponseTime(newTime: number): void {
    const totalRequests = this.stats.totalDegradedRequests + 1;
    this.stats.averageResponseTime = 
      (this.stats.averageResponseTime * (totalRequests - 1) + newTime) / totalRequests;
  }

  /**
   * Get request priority based on content
   */
  determineRequestPriority(userMessage: string, userId: string): RequestPriority {
    const lowerMessage = userMessage.toLowerCase();

    // Critical: Emergency or urgent keywords
    if (lowerMessage.includes('紧急') || lowerMessage.includes('urgent') ||
        lowerMessage.includes('emergency') || lowerMessage.includes('help')) {
      return 'critical';
    }

    // High: Questions or direct requests
    if (userMessage.includes('?') || userMessage.includes('？') ||
        lowerMessage.includes('请') || lowerMessage.includes('能不能')) {
      return 'high';
    }

    // Low: Very short messages or common greetings
    if (userMessage.length < 5 || 
        lowerMessage === '你好' || lowerMessage === 'hi' || lowerMessage === 'hello') {
      return 'low';
    }

    return 'normal';
  }

  /**
   * Get degradation statistics
   */
  getStats(): DegradationStats {
    return {
      ...this.stats,
      queuedRequests: this.requestQueue.length,
      levelHistory: [...this.stats.levelHistory]
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      currentLevel: this.currentState.level,
      totalDegradedRequests: 0,
      queuedRequests: 0,
      droppedRequests: 0,
      averageResponseTime: 0,
      lastLevelChange: null,
      levelHistory: []
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): DegradationConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<DegradationConfig>): void {
    this.config = { ...this.config, ...newConfig };
    if (newConfig.messages) {
      this.messages = { ...this.messages, ...newConfig.messages };
    }
  }

  /**
   * Check if system is in degraded state
   */
  isDegraded(): boolean {
    return this.currentState.level !== 'full';
  }

  /**
   * Check if system is in emergency state
   */
  isEmergency(): boolean {
    return this.currentState.level === 'emergency';
  }

  /**
   * Get available capabilities summary
   */
  getCapabilitiesSummary(): string[] {
    const summary: string[] = [];
    const caps = this.currentState.capabilities;

    if (caps.canProcessChat) summary.push('chat');
    if (caps.canMakeDecisions) summary.push('decisions');
    if (caps.canGenerateText) summary.push('generation');
    if (caps.canCheckProactive) summary.push('proactive');

    return summary;
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    if (this.queueProcessorTimer) {
      clearInterval(this.queueProcessorTimer);
      this.queueProcessorTimer = null;
    }

    // Reject all queued requests
    this.requestQueue.forEach(req => {
      req.reject(new Error('Service shutting down'));
    });
    this.requestQueue = [];
  }
}

// Export factory function
export function createGracefulDegradation(
  fallbackManager: FallbackManager,
  config?: Partial<DegradationConfig>
): GracefulDegradation {
  return new GracefulDegradation(fallbackManager, config);
}
