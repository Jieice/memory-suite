/**
 * ServiceOrchestrator
 * 
 * Coordinates requests between DecisionService and GenerationService
 * Implements service discovery, health monitoring, and response aggregation
 * Includes circuit breaker and retry logic for resilience
 * Integrates FallbackManager and GracefulDegradation for comprehensive error handling
 * 
 * Requirements: 2.1, 2.2, 2.5, 6.3, 8.1, 8.2, 8.3, 8.4
 */

import { httpPost, httpGet, HttpResult } from '../../shared/httpClient';
import { CircuitBreaker, CircuitBreakerOpenError, CircuitBreakerStats } from './CircuitBreaker';
import { RetryPolicy, RetryResult } from './RetryPolicy';
import { FallbackManager, FallbackConfig, FallbackStats } from './FallbackManager';
import { 
  GracefulDegradation, 
  DegradationConfig, 
  DegradationState, 
  DegradationStats,
  RequestPriority 
} from './GracefulDegradation';

// ============================================
// Types
// ============================================

export interface ServiceConfig {
  name: string;
  url: string;
  healthEndpoint: string;
  timeout: number;
  retries: number;
}

export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  lastCheck: Date;
  responseTime: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface OrchestratorConfig {
  decisionService: ServiceConfig;
  generationService: ServiceConfig;
  healthCheckInterval: number;
  requestTimeout: number;
}

export interface ChatRequest {
  text: string;
  userId: string;
  sessionId?: string;
  context?: Record<string, unknown>;
}

export interface ChatResponse {
  success: boolean;
  text?: string;
  error?: string;
  metadata?: {
    decisionTime: number;
    generationTime: number;
    totalTime: number;
    fallbackUsed: boolean;
    servicesUsed: string[];
  };
}

export interface DecisionRequest {
  stateVector: number[];
  perceptionVector: number[];
  messageEmbedding: number[];
  memoryContext: number[];
  allowedBehaviors: string[];
  constraints?: Record<string, unknown>;
}

export interface DecisionResponse {
  success: boolean;
  selectedBehavior?: {
    type: string;
    confidence: number;
    reasoning: string;
  };
  creativeGuidance?: {
    theme: string;
    keyPoints: string[];
    tone: { verbosity: number; sarcasm: number; warmth: number };
    style: { formality: number; creativity: number; engagement: number };
    constraints: { maxLength: number; forbiddenTopics: string[]; requiredElements: string[] };
  };
  proactiveBehaviors?: Record<string, number>;
  metadata?: {
    processingTime: number;
    nnConfidence: number;
    ruleWeight: number;
    fallbackUsed: boolean;
  };
  error?: { code: string; message: string };
}

export interface GenerationRequest {
  decision: DecisionResponse;
  context: {
    userMessage: string;
    allowedMemories: unknown[];
    conversationHistory: unknown[];
    userProfile?: Record<string, unknown>;
    streamingState?: Record<string, unknown>;
    sessionContext?: Record<string, unknown>;
  };
  constraints?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
    safetyLevel?: 'strict' | 'moderate' | 'relaxed';
  };
}

export interface GenerationResponse {
  success: boolean;
  text?: string;
  metadata?: {
    processingTime: number;
    tokenCount: number;
    model: string;
    temperature: number;
    guidanceFollowed: boolean;
    fallbackUsed: boolean;
    retryCount: number;
  };
  quality?: {
    coherence: number;
    relevance: number;
    creativity: number;
    safety: number;
  };
  error?: { code: string; message: string };
}

export interface ProactiveCheckRequest {
  streamingState: {
    isLive: boolean;
    silenceDuration: number;
    danmakuRate: number;
    viewerCount?: number;
  };
  lastInteractionTime: number;
  currentContext: {
    isInConversation: boolean;
    riskLevel?: number;
    userEngagement?: number;
  };
}

export interface ProactiveCheckResponse {
  success: boolean;
  decision?: {
    shouldAct: boolean;
    recommendedAction: string;
    confidence: number;
    behaviors: Record<string, number>;
    reasoning: string;
  };
  error?: { code: string; message: string };
}

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: OrchestratorConfig = {
  decisionService: {
    name: 'DecisionService',
    url: process.env.DECISION_SERVICE_URL || process.env.MEMORY_UNIVERSE_URL || `http://localhost:${process.env.MEMORY_UNIVERSE_PORT || 4005}`,
    healthEndpoint: '/health',
    timeout: 10000,
    retries: 2
  },
  generationService: {
    name: 'GenerationService',
    url: process.env.GENERATION_SERVICE_URL || process.env.BRAINNN_URL || `http://localhost:${process.env.BRAINNN_PORT || 4007}`,
    healthEndpoint: '/health',
    timeout: 30000,
    retries: 2
  },
  healthCheckInterval: 30000,
  requestTimeout: 60000
};

// ============================================
// ServiceOrchestrator Class
// ============================================

export class ServiceOrchestrator {
  private config: OrchestratorConfig;
  private serviceHealth: Map<string, ServiceHealth>;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  
  // Circuit breakers for each service
  private decisionCircuitBreaker: CircuitBreaker;
  private generationCircuitBreaker: CircuitBreaker;
  
  // Retry policies for each service
  private decisionRetryPolicy: RetryPolicy;
  private generationRetryPolicy: RetryPolicy;

  // Fallback and degradation managers
  private fallbackManager: FallbackManager;
  private gracefulDegradation: GracefulDegradation;

  constructor(config?: Partial<OrchestratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.serviceHealth = new Map();
    
    // Initialize circuit breakers
    this.decisionCircuitBreaker = new CircuitBreaker({
      name: 'DecisionService',
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 30000
    });
    
    this.generationCircuitBreaker = new CircuitBreaker({
      name: 'GenerationService',
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 60000 // Longer timeout for LLM service
    });
    
    // Initialize retry policies
    this.decisionRetryPolicy = new RetryPolicy({
      maxRetries: this.config.decisionService.retries,
      initialDelayMs: 500,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
      jitterFactor: 0.3
    });
    
    this.generationRetryPolicy = new RetryPolicy({
      maxRetries: this.config.generationService.retries,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      backoffMultiplier: 2,
      jitterFactor: 0.3
    });

    // Initialize fallback manager
    this.fallbackManager = new FallbackManager({
      enabled: true,
      timeoutMs: 5000,
      logFallbacks: true
    });

    // Initialize graceful degradation
    this.gracefulDegradation = new GracefulDegradation(this.fallbackManager, {
      enabled: true,
      maxQueueSize: 100,
      queueTimeoutMs: 30000,
      notifyUsers: true
    });
    
    // Initialize health status
    this.serviceHealth.set('decision', {
      name: this.config.decisionService.name,
      status: 'unknown',
      lastCheck: new Date(),
      responseTime: 0
    });
    this.serviceHealth.set('generation', {
      name: this.config.generationService.name,
      status: 'unknown',
      lastCheck: new Date(),
      responseTime: 0
    });
  }

  /**
   * Start the orchestrator and begin health monitoring
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    
    this.isRunning = true;
    console.log('[ServiceOrchestrator] Starting service orchestration...');
    
    // Initial health check
    await this.checkAllServicesHealth();
    
    // Start periodic health checks
    this.healthCheckTimer = setInterval(
      () => this.checkAllServicesHealth(),
      this.config.healthCheckInterval
    );
    
    console.log('[ServiceOrchestrator] Service orchestration started');
  }

  /**
   * Check health of all services
   */
  async checkAllServicesHealth(): Promise<Map<string, ServiceHealth>> {
    const [decisionHealth, generationHealth] = await Promise.all([
      this.checkServiceHealth('decision', this.config.decisionService),
      this.checkServiceHealth('generation', this.config.generationService)
    ]);
    
    this.serviceHealth.set('decision', decisionHealth);
    this.serviceHealth.set('generation', generationHealth);

    // Update graceful degradation state based on health
    this.gracefulDegradation.updateState(this.serviceHealth);
    
    return this.serviceHealth;
  }

  /**
   * Check health of a single service
   */
  private async checkServiceHealth(
    serviceKey: string,
    serviceConfig: ServiceConfig
  ): Promise<ServiceHealth> {
    const startTime = Date.now();
    
    try {
      const response = await httpGet<{ status: string; success: boolean }>(
        `${serviceConfig.url}${serviceConfig.healthEndpoint}`,
        { timeout: 5000 }
      );
      
      const responseTime = Date.now() - startTime;
      
      if (response.ok && response.data?.success !== false) {
        return {
          name: serviceConfig.name,
          status: response.data?.status === 'degraded' ? 'degraded' : 'healthy',
          lastCheck: new Date(),
          responseTime,
          details: response.data as Record<string, unknown>
        };
      } else {
        return {
          name: serviceConfig.name,
          status: 'unhealthy',
          lastCheck: new Date(),
          responseTime,
          error: response.error || 'Health check failed'
        };
      }
    } catch (error) {
      return {
        name: serviceConfig.name,
        status: 'unhealthy',
        lastCheck: new Date(),
        responseTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Get current health status of all services
   */
  getServicesHealth(): Map<string, ServiceHealth> {
    return new Map(this.serviceHealth);
  }

  /**
   * Get health status of a specific service
   */
  getServiceHealth(serviceKey: string): ServiceHealth | undefined {
    return this.serviceHealth.get(serviceKey);
  }

  /**
   * Check if a service is available
   */
  isServiceAvailable(serviceKey: string): boolean {
    const health = this.serviceHealth.get(serviceKey);
    return health?.status === 'healthy' || health?.status === 'degraded';
  }

  /**
   * Route decision request to DecisionService with circuit breaker and retry
   */
  async routeDecisionRequest(request: DecisionRequest): Promise<DecisionResponse> {
    // Check circuit breaker first
    if (!this.decisionCircuitBreaker.isAllowed()) {
      const retryAfter = this.decisionCircuitBreaker.getTimeUntilRetry();
      return {
        success: false,
        error: {
          code: 'CIRCUIT_BREAKER_OPEN',
          message: `DecisionService circuit breaker is open. Retry after ${retryAfter}ms`
        }
      };
    }
    
    if (!this.isServiceAvailable('decision')) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'DecisionService is not available'
        }
      };
    }
    
    try {
      // Execute with circuit breaker protection
      const result = await this.decisionCircuitBreaker.execute(async () => {
        // Execute with retry policy
        const retryResult = await this.decisionRetryPolicy.execute(async () => {
          const response = await httpPost<DecisionResponse>(
            `${this.config.decisionService.url}/api/decision`,
            request,
            { timeout: this.config.decisionService.timeout }
          );
          
          if (!response.ok) {
            throw new Error(response.error || 'Decision request failed');
          }
          
          return response.data!;
        });
        
        if (!retryResult.success) {
          throw retryResult.error;
        }
        
        return retryResult.result!;
      });
      
      return {
        ...result,
        success: result.success !== false
      };
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        return {
          success: false,
          error: {
            code: 'CIRCUIT_BREAKER_OPEN',
            message: error.message
          }
        };
      }
      
      return {
        success: false,
        error: {
          code: 'DECISION_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  /**
   * Route generation request to GenerationService with circuit breaker and retry
   */
  async routeGenerationRequest(request: GenerationRequest): Promise<GenerationResponse> {
    // Check circuit breaker first
    if (!this.generationCircuitBreaker.isAllowed()) {
      const retryAfter = this.generationCircuitBreaker.getTimeUntilRetry();
      return {
        success: false,
        error: {
          code: 'CIRCUIT_BREAKER_OPEN',
          message: `GenerationService circuit breaker is open. Retry after ${retryAfter}ms`
        }
      };
    }
    
    if (!this.isServiceAvailable('generation')) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'GenerationService is not available'
        }
      };
    }
    
    try {
      // Execute with circuit breaker protection
      const result = await this.generationCircuitBreaker.execute(async () => {
        // Execute with retry policy
        const retryResult = await this.generationRetryPolicy.execute(async () => {
          const response = await httpPost<GenerationResponse>(
            `${this.config.generationService.url}/api/generate`,
            request,
            { timeout: this.config.generationService.timeout }
          );
          
          if (!response.ok) {
            throw new Error(response.error || 'Generation request failed');
          }
          
          return response.data!;
        });
        
        if (!retryResult.success) {
          throw retryResult.error;
        }
        
        return retryResult.result!;
      });
      
      return {
        ...result,
        success: result.success !== false
      };
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        return {
          success: false,
          error: {
            code: 'CIRCUIT_BREAKER_OPEN',
            message: error.message
          }
        };
      }
      
      return {
        success: false,
        error: {
          code: 'GENERATION_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  /**
   * Route proactive check request to DecisionService
   */
  async routeProactiveCheck(request: ProactiveCheckRequest): Promise<ProactiveCheckResponse> {
    if (!this.isServiceAvailable('decision')) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'DecisionService is not available'
        }
      };
    }
    
    try {
      const response = await httpPost<ProactiveCheckResponse>(
        `${this.config.decisionService.url}/api/proactive/check`,
        request,
        {
          timeout: this.config.decisionService.timeout
        }
      );
      
      if (response.ok && response.data) {
        return {
          ...response.data,
          success: response.data.success !== false
        };
      } else {
        return {
          success: false,
          error: {
            code: 'PROACTIVE_CHECK_FAILED',
            message: response.error || 'Proactive check failed'
          }
        };
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'PROACTIVE_CHECK_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  /**
   * Get aggregated statistics from all services
   */
  async getAggregatedStats(): Promise<{
    decision?: Record<string, unknown>;
    generation?: Record<string, unknown>;
    orchestrator: {
      servicesHealthy: number;
      servicesTotal: number;
      lastHealthCheck: Date;
    };
  }> {
    const [decisionStats, generationStats] = await Promise.all([
      this.getServiceStats('decision'),
      this.getServiceStats('generation')
    ]);
    
    const healthyCount = Array.from(this.serviceHealth.values())
      .filter(h => h.status === 'healthy' || h.status === 'degraded').length;
    
    return {
      decision: decisionStats,
      generation: generationStats,
      orchestrator: {
        servicesHealthy: healthyCount,
        servicesTotal: this.serviceHealth.size,
        lastHealthCheck: new Date()
      }
    };
  }

  /**
   * Get statistics from a specific service
   */
  private async getServiceStats(serviceKey: string): Promise<Record<string, unknown> | undefined> {
    const config = serviceKey === 'decision' 
      ? this.config.decisionService 
      : this.config.generationService;
    
    try {
      const response = await httpGet<{ stats: Record<string, unknown> }>(
        `${config.url}/api/stats`,
        { timeout: 5000 }
      );
      
      if (response.ok && response.data) {
        return response.data.stats || response.data;
      }
    } catch (error) {
      console.error(`[ServiceOrchestrator] Failed to get stats from ${serviceKey}:`, error);
    }
    
    return undefined;
  }

  /**
   * Get orchestrator configuration
   */
  getConfig(): OrchestratorConfig {
    return { ...this.config };
  }

  /**
   * Update orchestrator configuration
   */
  updateConfig(newConfig: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...newConfig };
    
    // Restart health check timer if interval changed
    if (newConfig.healthCheckInterval && this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = setInterval(
        () => this.checkAllServicesHealth(),
        this.config.healthCheckInterval
      );
    }
  }

  /**
   * Backward compatibility: Process chat request through both services
   * This orchestrates the full flow: Decision → Generation
   * Now with graceful degradation support
   * 
   * Requirements: 6.3 - Maintain existing API contracts
   * Requirements: 8.3 - Graceful degradation with appropriate fallback responses
   */
  async processChat(request: ChatRequest): Promise<ChatResponse> {
    const startTime = Date.now();

    // Determine request priority
    const priority = this.gracefulDegradation.determineRequestPriority(
      request.text,
      request.userId
    );

    // Use graceful degradation to process the chat
    return this.gracefulDegradation.processChatWithDegradation(
      request.text,
      request.userId,
      // Decision processor
      async () => {
        const decisionRequest: DecisionRequest = {
          stateVector: this.buildDefaultStateVector(),
          perceptionVector: this.buildDefaultPerceptionVector(request.text),
          messageEmbedding: this.buildDefaultEmbedding(request.text),
          memoryContext: new Array(32).fill(0),
          allowedBehaviors: [
            'reply_friendly', 'reply_supportive', 'reply_playful',
            'tease_light', 'dodge', 'silent', 'topic_shift',
            'clarify_question', 'emotional_resonate'
          ],
          constraints: request.context
        };
        return this.routeDecisionRequest(decisionRequest);
      },
      // Generation processor
      async (decision: DecisionResponse) => {
        const generationRequest: GenerationRequest = {
          decision,
          context: {
            userMessage: request.text,
            allowedMemories: [],
            conversationHistory: [],
            userProfile: { userId: request.userId },
            sessionContext: request.sessionId ? { sessionId: request.sessionId } : undefined
          },
          constraints: {
            maxTokens: 500,
            temperature: 0.7,
            safetyLevel: 'moderate'
          }
        };
        return this.routeGenerationRequest(generationRequest);
      },
      priority
    );
  }

  /**
   * Process chat without graceful degradation (legacy method)
   * Kept for backward compatibility
   */
  async processChatLegacy(request: ChatRequest): Promise<ChatResponse> {
    const startTime = Date.now();
    const servicesUsed: string[] = [];
    let fallbackUsed = false;
    
    try {
      // Step 1: Build decision request from chat request
      // Use default vectors for backward compatibility
      const decisionRequest: DecisionRequest = {
        stateVector: this.buildDefaultStateVector(),
        perceptionVector: this.buildDefaultPerceptionVector(request.text),
        messageEmbedding: this.buildDefaultEmbedding(request.text),
        memoryContext: new Array(32).fill(0),
        allowedBehaviors: [
          'reply_friendly', 'reply_supportive', 'reply_playful',
          'tease_light', 'dodge', 'silent', 'topic_shift',
          'clarify_question', 'emotional_resonate'
        ],
        constraints: request.context
      };
      
      // Step 2: Get decision from DecisionService
      const decisionStartTime = Date.now();
      const decisionResponse = await this.routeDecisionRequest(decisionRequest);
      const decisionTime = Date.now() - decisionStartTime;
      
      if (decisionResponse.success) {
        servicesUsed.push('DecisionService');
      } else {
        // Use fallback decision if DecisionService fails
        fallbackUsed = true;
        console.warn('[ServiceOrchestrator] DecisionService failed, using fallback');
      }
      
      // Step 3: Build generation request
      const generationRequest: GenerationRequest = {
        decision: decisionResponse.success ? decisionResponse : this.buildFallbackDecision(),
        context: {
          userMessage: request.text,
          allowedMemories: [],
          conversationHistory: [],
          userProfile: { userId: request.userId },
          sessionContext: request.sessionId ? { sessionId: request.sessionId } : undefined
        },
        constraints: {
          maxTokens: 500,
          temperature: 0.7,
          safetyLevel: 'moderate'
        }
      };
      
      // Step 4: Get generation from GenerationService
      const generationStartTime = Date.now();
      const generationResponse = await this.routeGenerationRequest(generationRequest);
      const generationTime = Date.now() - generationStartTime;
      
      if (generationResponse.success) {
        servicesUsed.push('GenerationService');
      } else {
        // Use fallback response if GenerationService fails
        fallbackUsed = true;
        console.warn('[ServiceOrchestrator] GenerationService failed, using fallback');
        
        return {
          success: true,
          text: this.buildFallbackResponse(request.text),
          metadata: {
            decisionTime,
            generationTime,
            totalTime: Date.now() - startTime,
            fallbackUsed: true,
            servicesUsed
          }
        };
      }
      
      return {
        success: true,
        text: generationResponse.text,
        metadata: {
          decisionTime,
          generationTime,
          totalTime: Date.now() - startTime,
          fallbackUsed,
          servicesUsed
        }
      };
      
    } catch (error) {
      console.error('[ServiceOrchestrator] Chat processing error:', error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        metadata: {
          decisionTime: 0,
          generationTime: 0,
          totalTime: Date.now() - startTime,
          fallbackUsed: true,
          servicesUsed
        }
      };
    }
  }

  /**
   * Build default state vector for backward compatibility
   */
  private buildDefaultStateVector(): number[] {
    // 27-dimensional state vector with reasonable defaults
    return [
      0.5, 0.2, 0.1, 0.5, 0.3,  // emotion: joy, sadness, anger, curiosity, fatigue
      0.6, 0.5, 0.6, 0.7, 0.0,  // persona: energy, talkativeness, openness, willingness, reserved
      0.5, 0.3, 0.2,            // audience: excited, bored, tense
      0.2, 0.1, 0.2,            // conflict: hesitation, turmoil, decisionDifficulty
      0.0, 0.0, 0.0, 0.0, 0.0,  // reserved
      0.0, 0.0, 0.0, 0.0, 0.0, 0.0  // reserved
    ];
  }

  /**
   * Build default perception vector from message
   */
  private buildDefaultPerceptionVector(message: string): number[] {
    // 8-dimensional perception vector
    const length = message.length;
    const hasQuestion = message.includes('?') ? 0.8 : 0.2;
    const hasExclamation = message.includes('!') ? 0.6 : 0.3;
    
    return [
      0.5,           // sentiment (neutral)
      0.3,           // riskHint (low)
      0.7,           // confidence
      hasQuestion,   // questionLikelihood
      hasExclamation, // emotionIntensity
      Math.min(length / 100, 1), // messageComplexity
      0.5,           // topicRelevance
      0.5            // engagementLevel
    ];
  }

  /**
   * Build default embedding from message (simple hash-based)
   */
  private buildDefaultEmbedding(message: string): number[] {
    // 32-dimensional embedding (simple placeholder)
    const embedding = new Array(32).fill(0);
    for (let i = 0; i < message.length && i < 32; i++) {
      embedding[i] = (message.charCodeAt(i) % 100) / 100;
    }
    return embedding;
  }

  /**
   * Build fallback decision when DecisionService is unavailable
   */
  private buildFallbackDecision(): DecisionResponse {
    return {
      success: true,
      selectedBehavior: {
        type: 'reply_friendly',
        confidence: 0.5,
        reasoning: 'Fallback decision due to service unavailability'
      },
      creativeGuidance: {
        theme: 'friendly_conversation',
        keyPoints: ['engage_with_user', 'be_helpful'],
        tone: { verbosity: 0.5, sarcasm: 0.1, warmth: 0.7 },
        style: { formality: 0.3, creativity: 0.5, engagement: 0.7 },
        constraints: { maxLength: 200, forbiddenTopics: [], requiredElements: [] }
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
  }

  /**
   * Build fallback response when GenerationService is unavailable
   */
  private buildFallbackResponse(userMessage: string): string {
    const fallbackResponses = [
      '抱歉，我现在有点忙，稍后再聊好吗？',
      '嗯嗯，我听到了~',
      '谢谢你的消息！',
      '好的好的~',
      '收到啦！'
    ];
    
    // Simple hash to select a consistent response
    const hash = userMessage.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    return fallbackResponses[hash % fallbackResponses.length];
  }

  /**
   * Get circuit breaker statistics
   */
  getCircuitBreakerStats(): {
    decision: CircuitBreakerStats;
    generation: CircuitBreakerStats;
  } {
    return {
      decision: this.decisionCircuitBreaker.getStats(),
      generation: this.generationCircuitBreaker.getStats()
    };
  }

  /**
   * Reset circuit breakers (for recovery)
   */
  resetCircuitBreakers(): void {
    this.decisionCircuitBreaker.reset();
    this.generationCircuitBreaker.reset();
    console.log('[ServiceOrchestrator] Circuit breakers reset');
  }

  /**
   * Check if orchestrator is running
   */
  isOrchestratorRunning(): boolean {
    return this.isRunning;
  }

  // ============================================
  // Fallback and Degradation Management
  // ============================================

  /**
   * Get the FallbackManager instance
   */
  getFallbackManager(): FallbackManager {
    return this.fallbackManager;
  }

  /**
   * Get the GracefulDegradation instance
   */
  getGracefulDegradation(): GracefulDegradation {
    return this.gracefulDegradation;
  }

  /**
   * Get current degradation state
   */
  getDegradationState(): DegradationState {
    return this.gracefulDegradation.getState();
  }

  /**
   * Check if system is in degraded state
   */
  isDegraded(): boolean {
    return this.gracefulDegradation.isDegraded();
  }

  /**
   * Check if system is in emergency state
   */
  isEmergency(): boolean {
    return this.gracefulDegradation.isEmergency();
  }

  /**
   * Get fallback statistics
   */
  getFallbackStats(): FallbackStats {
    return this.fallbackManager.getStats();
  }

  /**
   * Get degradation statistics
   */
  getDegradationStats(): DegradationStats {
    return this.gracefulDegradation.getStats();
  }

  /**
   * Get comprehensive resilience statistics
   */
  getResilienceStats(): {
    circuitBreakers: { decision: CircuitBreakerStats; generation: CircuitBreakerStats };
    fallback: FallbackStats;
    degradation: DegradationStats;
  } {
    return {
      circuitBreakers: this.getCircuitBreakerStats(),
      fallback: this.getFallbackStats(),
      degradation: this.getDegradationStats()
    };
  }

  /**
   * Reset all resilience statistics
   */
  resetResilienceStats(): void {
    this.resetCircuitBreakers();
    this.fallbackManager.resetStats();
    this.gracefulDegradation.resetStats();
    console.log('[ServiceOrchestrator] All resilience stats reset');
  }

  /**
   * Get user-friendly status message for current state
   */
  getStatusMessage(): string {
    return this.gracefulDegradation.getStatusMessage();
  }

  /**
   * Get available capabilities in current state
   */
  getAvailableCapabilities(): string[] {
    return this.gracefulDegradation.getCapabilitiesSummary();
  }

  /**
   * Stop the orchestrator and clean up resources
   */
  stop(): void {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Clean up graceful degradation resources
    this.gracefulDegradation.cleanup();
    
    console.log('[ServiceOrchestrator] Service orchestration stopped');
  }
}

// Export singleton instance
export const orchestrator = new ServiceOrchestrator();
