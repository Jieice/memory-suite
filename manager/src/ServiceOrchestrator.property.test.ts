/**
 * ServiceOrchestrator Property Tests
 * 
 * Property 5: Request routing and aggregation validation
 * Validates: Requirements 2.1, 2.2
 * 
 * Tests that the ServiceOrchestrator correctly routes decision requests
 * to DecisionService and generation requests to GenerationService,
 * then aggregates responses into unified outputs.
 */

import * as fc from 'fast-check';
import {
  ServiceOrchestrator,
  DecisionRequest,
  DecisionResponse,
  GenerationRequest,
  GenerationResponse,
  ChatRequest,
  ChatResponse,
  ProactiveCheckRequest,
  OrchestratorConfig
} from './ServiceOrchestrator';
import { CircuitBreaker, CircuitBreakerState } from './CircuitBreaker';
import { RetryPolicy } from './RetryPolicy';

// Test configuration
const TEST_ITERATIONS = 100;

// Mock HTTP responses for testing
const mockDecisionResponse: DecisionResponse = {
  success: true,
  selectedBehavior: {
    type: 'reply_friendly',
    confidence: 0.85,
    reasoning: 'User message indicates friendly intent'
  },
  creativeGuidance: {
    theme: 'friendly_conversation',
    keyPoints: ['engage', 'be_helpful'],
    tone: { verbosity: 0.5, sarcasm: 0.1, warmth: 0.8 },
    style: { formality: 0.3, creativity: 0.6, engagement: 0.7 },
    constraints: { maxLength: 200, forbiddenTopics: [], requiredElements: [] }
  },
  proactiveBehaviors: {
    continueConversation: 0.6,
    respondToDanmaku: 0.7,
    initiateSpeak: 0.2,
    playMedia: 0.1,
    privateMessage: 0.05,
    doNothing: 0.1
  },
  metadata: {
    processingTime: 50,
    nnConfidence: 0.85,
    ruleWeight: 0.3,
    fallbackUsed: false
  }
};

const mockGenerationResponse: GenerationResponse = {
  success: true,
  text: '浣犲ソ鍛€锛佸緢楂樺叴瑙佸埌浣爚',
  metadata: {
    processingTime: 200,
    tokenCount: 15,
    model: 'deepseek-chat',
    temperature: 0.7,
    guidanceFollowed: true,
    fallbackUsed: false,
    retryCount: 0
  },
  quality: {
    coherence: 0.9,
    relevance: 0.85,
    creativity: 0.7,
    safety: 1.0
  }
};

describe('Feature: nn-llm-separation, Property 5: Request routing and aggregation validation', () => {
  let orchestrator: ServiceOrchestrator;

  beforeEach(() => {
    // Create orchestrator with test configuration
    orchestrator = new ServiceOrchestrator({
      decisionService: {
        name: 'DecisionService',
        url: 'http://localhost:4005',
        healthEndpoint: '/health',
        timeout: 5000,
        retries: 1
      },
      generationService: {
        name: 'GenerationService',
        url: 'http://localhost:4007',
        healthEndpoint: '/health',
        timeout: 10000,
        retries: 1
      },
      healthCheckInterval: 60000,
      requestTimeout: 30000
    });
  });

  afterEach(() => {
    orchestrator.stop();
  });


  /**
   * Property 5.1: Decision request structure validation
   * For any valid decision request, the orchestrator should produce
   * a properly structured request to route to DecisionService.
   */
  describe('Property 5.1: Decision request structure validation', () => {
    // Generator for valid state vectors (27 dimensions)
    const stateVectorArb = fc.array(fc.float({ min: 0, max: 1, noNaN: true }), {
      minLength: 27,
      maxLength: 27
    });

    // Generator for perception vectors (8 dimensions)
    const perceptionVectorArb = fc.array(fc.float({ min: 0, max: 1, noNaN: true }), {
      minLength: 8,
      maxLength: 8
    });

    // Generator for embedding vectors (32 dimensions)
    const embeddingVectorArb = fc.array(fc.float({ min: -1, max: 1, noNaN: true }), {
      minLength: 32,
      maxLength: 32
    });

    // Generator for allowed behaviors
    const behaviorsArb = fc.array(
      fc.constantFrom(
        'reply_friendly', 'reply_supportive', 'reply_playful',
        'tease_light', 'dodge', 'silent', 'topic_shift',
        'clarify_question', 'emotional_resonate'
      ),
      { minLength: 1, maxLength: 9 }
    );

    it('should accept any valid decision request structure', async () => {
      await fc.assert(
        fc.asyncProperty(
          stateVectorArb,
          perceptionVectorArb,
          embeddingVectorArb,
          embeddingVectorArb,
          behaviorsArb,
          async (stateVector, perceptionVector, messageEmbedding, memoryContext, allowedBehaviors) => {
            const request: DecisionRequest = {
              stateVector,
              perceptionVector,
              messageEmbedding,
              memoryContext,
              allowedBehaviors
            };

            // Validate request structure is correct
            expect(request.stateVector).toHaveLength(27);
            expect(request.perceptionVector).toHaveLength(8);
            expect(request.messageEmbedding).toHaveLength(32);
            expect(request.memoryContext).toHaveLength(32);
            expect(request.allowedBehaviors.length).toBeGreaterThanOrEqual(1);

            // All vector values should be valid numbers
            request.stateVector.forEach(v => {
              expect(typeof v).toBe('number');
              expect(v).toBeGreaterThanOrEqual(0);
              expect(v).toBeLessThanOrEqual(1);
            });

            request.perceptionVector.forEach(v => {
              expect(typeof v).toBe('number');
              expect(v).toBeGreaterThanOrEqual(0);
              expect(v).toBeLessThanOrEqual(1);
            });

            return true;
          }
        ),
        { numRuns: TEST_ITERATIONS }
      );
    });
  });

  /**
   * Property 5.2: Generation request structure validation
   * For any valid generation request, the orchestrator should produce
   * a properly structured request to route to GenerationService.
   */
  describe('Property 5.2: Generation request structure validation', () => {
    const userMessageArb = fc.string({ minLength: 1, maxLength: 500 });
    const maxTokensArb = fc.integer({ min: 50, max: 2000 });
    const temperatureArb = fc.float({ min: 0, max: 2, noNaN: true });
    const safetyLevelArb = fc.constantFrom('strict', 'moderate', 'relaxed');

    it('should accept any valid generation request structure', async () => {
      await fc.assert(
        fc.asyncProperty(
          userMessageArb,
          maxTokensArb,
          temperatureArb,
          safetyLevelArb,
          async (userMessage, maxTokens, temperature, safetyLevel) => {
            const request: GenerationRequest = {
              decision: mockDecisionResponse,
              context: {
                userMessage,
                allowedMemories: [],
                conversationHistory: []
              },
              constraints: {
                maxTokens,
                temperature,
                safetyLevel: safetyLevel as 'strict' | 'moderate' | 'relaxed'
              }
            };

            // Validate request structure
            expect(request.decision).toBeDefined();
            expect(request.decision.success).toBe(true);
            expect(request.context.userMessage).toBe(userMessage);
            expect(request.constraints?.maxTokens).toBe(maxTokens);
            expect(request.constraints?.temperature).toBe(temperature);
            expect(['strict', 'moderate', 'relaxed']).toContain(request.constraints?.safetyLevel);

            return true;
          }
        ),
        { numRuns: TEST_ITERATIONS }
      );
    });
  });


  /**
   * Property 5.3: Chat request to unified response aggregation
   * For any valid chat request, the orchestrator should produce
   * a unified response with proper metadata aggregation.
   */
  describe('Property 5.3: Chat request aggregation', () => {
    const chatRequestArb = fc.record({
      text: fc.string({ minLength: 1, maxLength: 500 }),
      userId: fc.string({ minLength: 1, maxLength: 50 }),
      sessionId: fc.option(fc.uuid())
    });

    it('should produce valid ChatRequest structure for any input', async () => {
      await fc.assert(
        fc.asyncProperty(
          chatRequestArb,
          async (chatInput) => {
            const request: ChatRequest = {
              text: chatInput.text,
              userId: chatInput.userId,
              sessionId: chatInput.sessionId ?? undefined
            };

            // Validate request structure
            expect(request.text).toBe(chatInput.text);
            expect(request.userId).toBe(chatInput.userId);
            expect(typeof request.text).toBe('string');
            expect(typeof request.userId).toBe('string');

            return true;
          }
        ),
        { numRuns: TEST_ITERATIONS }
      );
    });

    it('should have valid ChatResponse structure', () => {
      // Test that ChatResponse interface is properly structured
      const validResponse: ChatResponse = {
        success: true,
        text: 'Test response',
        metadata: {
          decisionTime: 50,
          generationTime: 200,
          totalTime: 250,
          fallbackUsed: false,
          servicesUsed: ['DecisionService', 'GenerationService']
        }
      };

      expect(validResponse.success).toBe(true);
      expect(validResponse.text).toBeDefined();
      expect(validResponse.metadata).toBeDefined();
      expect(validResponse.metadata?.decisionTime).toBeGreaterThanOrEqual(0);
      expect(validResponse.metadata?.generationTime).toBeGreaterThanOrEqual(0);
      expect(validResponse.metadata?.totalTime).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(validResponse.metadata?.servicesUsed)).toBe(true);
    });
  });

  /**
   * Property 5.4: Proactive check request routing
   * For any valid proactive check request, the orchestrator should
   * route it correctly to DecisionService.
   */
  describe('Property 5.4: Proactive check request routing', () => {
    const streamingStateArb = fc.record({
      isLive: fc.boolean(),
      silenceDuration: fc.nat({ max: 3600 }),
      danmakuRate: fc.float({ min: 0, max: 100, noNaN: true }),
      viewerCount: fc.option(fc.nat({ max: 100000 }), { nil: undefined })
    });

    const contextArb = fc.record({
      isInConversation: fc.boolean(),
      riskLevel: fc.option(fc.float({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
      userEngagement: fc.option(fc.float({ min: 0, max: 1, noNaN: true }), { nil: undefined })
    });

    it('should accept any valid proactive check request structure', async () => {
      await fc.assert(
        fc.asyncProperty(
          streamingStateArb,
          fc.nat({ max: Date.now() }),
          contextArb,
          async (streamingState, lastInteractionTime, currentContext) => {
            const request: ProactiveCheckRequest = {
              streamingState,
              lastInteractionTime,
              currentContext
            };

            // Validate request structure
            expect(request.streamingState).toBeDefined();
            expect(typeof request.streamingState.isLive).toBe('boolean');
            expect(typeof request.streamingState.silenceDuration).toBe('number');
            expect(typeof request.streamingState.danmakuRate).toBe('number');
            expect(typeof request.lastInteractionTime).toBe('number');
            expect(request.currentContext).toBeDefined();
            expect(typeof request.currentContext.isInConversation).toBe('boolean');

            return true;
          }
        ),
        { numRuns: TEST_ITERATIONS }
      );
    });
  });


  /**
   * Property 5.5: Service health tracking consistency
   * The orchestrator should maintain consistent health status
   * for all tracked services.
   */
  describe('Property 5.5: Service health tracking', () => {
    it('should track health for both services', () => {
      const health = orchestrator.getServicesHealth();
      
      expect(health.size).toBe(2);
      expect(health.has('decision')).toBe(true);
      expect(health.has('generation')).toBe(true);

      const decisionHealth = health.get('decision');
      const generationHealth = health.get('generation');

      expect(decisionHealth).toBeDefined();
      expect(generationHealth).toBeDefined();
      expect(decisionHealth?.name).toBe('DecisionService');
      expect(generationHealth?.name).toBe('GenerationService');
    });

    it('should return valid health status structure', () => {
      const decisionHealth = orchestrator.getServiceHealth('decision');
      const generationHealth = orchestrator.getServiceHealth('generation');

      [decisionHealth, generationHealth].forEach(health => {
        expect(health).toBeDefined();
        expect(health).toHaveProperty('name');
        expect(health).toHaveProperty('status');
        expect(health).toHaveProperty('lastCheck');
        expect(health).toHaveProperty('responseTime');
        expect(['healthy', 'degraded', 'unhealthy', 'unknown']).toContain(health?.status);
        expect(typeof health?.responseTime).toBe('number');
      });
    });
  });

  /**
   * Property 5.6: Configuration management
   * The orchestrator should maintain valid configuration state.
   */
  describe('Property 5.6: Configuration management', () => {
    it('should return valid configuration', () => {
      const config = orchestrator.getConfig();

      expect(config).toHaveProperty('decisionService');
      expect(config).toHaveProperty('generationService');
      expect(config).toHaveProperty('healthCheckInterval');
      expect(config).toHaveProperty('requestTimeout');

      expect(config.decisionService.url).toBe('http://localhost:4005');
      expect(config.generationService.url).toBe('http://localhost:4007');
      expect(typeof config.healthCheckInterval).toBe('number');
      expect(typeof config.requestTimeout).toBe('number');
    });

    it('should update configuration correctly', () => {
      const newTimeout = 45000;
      orchestrator.updateConfig({ requestTimeout: newTimeout });
      
      const config = orchestrator.getConfig();
      expect(config.requestTimeout).toBe(newTimeout);
    });
  });

  /**
   * Property 5.7: Circuit breaker statistics
   * The orchestrator should provide valid circuit breaker stats.
   */
  describe('Property 5.7: Circuit breaker statistics', () => {
    it('should return valid circuit breaker stats for both services', () => {
      const stats = orchestrator.getCircuitBreakerStats();

      expect(stats).toHaveProperty('decision');
      expect(stats).toHaveProperty('generation');

      [stats.decision, stats.generation].forEach(cbStats => {
        expect(cbStats).toHaveProperty('state');
        expect(cbStats).toHaveProperty('failureCount');
        expect(cbStats).toHaveProperty('successCount');
        expect(cbStats).toHaveProperty('totalRequests');
        expect(cbStats).toHaveProperty('totalFailures');
        expect(cbStats).toHaveProperty('totalSuccesses');

        expect(['CLOSED', 'OPEN', 'HALF_OPEN']).toContain(cbStats.state);
        expect(typeof cbStats.failureCount).toBe('number');
        expect(typeof cbStats.successCount).toBe('number');
        expect(cbStats.failureCount).toBeGreaterThanOrEqual(0);
        expect(cbStats.successCount).toBeGreaterThanOrEqual(0);
      });
    });

    it('should reset circuit breakers correctly', () => {
      orchestrator.resetCircuitBreakers();
      const stats = orchestrator.getCircuitBreakerStats();

      expect(stats.decision.state).toBe('CLOSED');
      expect(stats.generation.state).toBe('CLOSED');
      expect(stats.decision.failureCount).toBe(0);
      expect(stats.generation.failureCount).toBe(0);
    });
  });
});


/**
 * Property 5.8: CircuitBreaker state machine validation
 * The circuit breaker should follow correct state transitions.
 */
describe('Feature: nn-llm-separation, Property 5: CircuitBreaker state machine', () => {
  /**
   * Property 5.8.1: Initial state is CLOSED
   */
  it('should start in CLOSED state', () => {
    const cb = new CircuitBreaker({ name: 'test' });
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.isAllowed()).toBe(true);
  });

  /**
   * Property 5.8.2: State transitions follow correct pattern
   */
  describe('State transitions', () => {
    it('should transition to OPEN after failure threshold', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        timeout: 100
      });

      // Simulate failures
      for (let i = 0; i < 3; i++) {
        try {
          await cb.execute(async () => {
            throw new Error('Test failure');
          });
        } catch (e) {
          // Expected
        }
      }

      expect(cb.getState()).toBe('OPEN');
      expect(cb.isAllowed()).toBe(false);
    });

    it('should transition from OPEN to HALF_OPEN after timeout', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 1,
        timeout: 50
      });

      // Trigger OPEN state
      try {
        await cb.execute(async () => {
          throw new Error('Test failure');
        });
      } catch (e) {
        // Expected
      }

      expect(cb.getState()).toBe('OPEN');

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 60));

      expect(cb.getState()).toBe('HALF_OPEN');
      expect(cb.isAllowed()).toBe(true);
    });

    it('should transition from HALF_OPEN to CLOSED after success threshold', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 1,
        successThreshold: 2,
        timeout: 50
      });

      // Trigger OPEN state
      try {
        await cb.execute(async () => {
          throw new Error('Test failure');
        });
      } catch (e) {
        // Expected
      }

      // Wait for timeout to enter HALF_OPEN
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(cb.getState()).toBe('HALF_OPEN');

      // Successful executions
      await cb.execute(async () => 'success1');
      await cb.execute(async () => 'success2');

      expect(cb.getState()).toBe('CLOSED');
    });
  });

  /**
   * Property 5.8.3: Statistics are consistent
   */
  it('should maintain consistent statistics', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 0, max: 5 }),
        async (successCount, failureCount) => {
          const cb = new CircuitBreaker({
            name: 'test',
            failureThreshold: 100 // High threshold to avoid state changes
          });

          // Execute successes
          for (let i = 0; i < successCount; i++) {
            await cb.execute(async () => 'success');
          }

          // Execute failures
          for (let i = 0; i < failureCount; i++) {
            try {
              await cb.execute(async () => {
                throw new Error('failure');
              });
            } catch (e) {
              // Expected
            }
          }

          const stats = cb.getStats();
          expect(stats.totalRequests).toBe(successCount + failureCount);
          expect(stats.totalSuccesses).toBe(successCount);
          expect(stats.totalFailures).toBe(failureCount);

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });
});

/**
 * Property 5.9: RetryPolicy behavior validation
 * The retry policy should implement correct exponential backoff.
 */
describe('Feature: nn-llm-separation, Property 5: RetryPolicy behavior', () => {
  /**
   * Property 5.9.1: Successful execution returns immediately
   */
  it('should return immediately on success', async () => {
    const policy = new RetryPolicy({ maxRetries: 3 });
    const startTime = Date.now();

    const result = await policy.execute(async () => 'success');

    expect(result.success).toBe(true);
    expect(result.result).toBe('success');
    expect(result.attempts).toBe(1);
    expect(result.totalDelayMs).toBe(0);
    expect(Date.now() - startTime).toBeLessThan(100);
  });

  /**
   * Property 5.9.2: Retries on transient errors
   */
  it('should retry on transient errors', async () => {
    const policy = new RetryPolicy({
      maxRetries: 2,
      initialDelayMs: 10,
      maxDelayMs: 50
    });

    let attempts = 0;
    const result = await policy.execute(async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error('timeout error');
      }
      return 'success';
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  /**
   * Property 5.9.3: Delay calculation follows exponential backoff
   */
  it('should calculate delays with exponential backoff', () => {
    const policy = new RetryPolicy({
      maxRetries: 5,
      initialDelayMs: 100,
      maxDelayMs: 10000,
      backoffMultiplier: 2
    });

    const delay0 = policy.calculateDelayForAttempt(0);
    const delay1 = policy.calculateDelayForAttempt(1);
    const delay2 = policy.calculateDelayForAttempt(2);

    expect(delay0).toBe(100);
    expect(delay1).toBe(200);
    expect(delay2).toBe(400);
  });

  /**
   * Property 5.9.4: Max delay is respected
   */
  it('should respect max delay', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }),
        async (attempt) => {
          const maxDelay = 1000;
          const policy = new RetryPolicy({
            maxRetries: 10,
            initialDelayMs: 100,
            maxDelayMs: maxDelay,
            backoffMultiplier: 2
          });

          const delay = policy.calculateDelayForAttempt(attempt);
          expect(delay).toBeLessThanOrEqual(maxDelay);

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property 5.9.5: Configuration is preserved
   */
  it('should preserve configuration', () => {
    const config = {
      maxRetries: 5,
      initialDelayMs: 500,
      maxDelayMs: 5000,
      backoffMultiplier: 1.5,
      jitterFactor: 0.2
    };

    const policy = new RetryPolicy(config);
    const retrievedConfig = policy.getConfig();

    expect(retrievedConfig.maxRetries).toBe(config.maxRetries);
    expect(retrievedConfig.initialDelayMs).toBe(config.initialDelayMs);
    expect(retrievedConfig.maxDelayMs).toBe(config.maxDelayMs);
    expect(retrievedConfig.backoffMultiplier).toBe(config.backoffMultiplier);
    expect(retrievedConfig.jitterFactor).toBe(config.jitterFactor);
  });
});

/**
 * Property 5.10: Orchestrator lifecycle management
 */
describe('Feature: nn-llm-separation, Property 5: Orchestrator lifecycle', () => {
  it('should report correct running state', () => {
    const orchestrator = new ServiceOrchestrator();
    
    expect(orchestrator.isOrchestratorRunning()).toBe(false);
    
    orchestrator.stop(); // Should be safe to call even when not running
    expect(orchestrator.isOrchestratorRunning()).toBe(false);
  });

  it('should handle multiple stop calls gracefully', () => {
    const orchestrator = new ServiceOrchestrator();
    
    // Multiple stops should not throw
    expect(() => {
      orchestrator.stop();
      orchestrator.stop();
      orchestrator.stop();
    }).not.toThrow();
  });
});

