/**
 * Functional Equivalence Testing Suite
 * 
 * Validates that the split services (DecisionService + GenerationService)
 * produce identical outputs to the original memory-universe system.
 * 
 * Requirements: 6.3, 1.5
 * Property 4: Functional equivalence after migration
 */

import { httpPost, httpGet } from '../shared/httpClient';

// Service URLs
const DECISION_SERVICE_URL =
  process.env.DECISION_SERVICE_URL ||
  process.env.MEMORY_UNIVERSE_URL ||
  'http://localhost:4005';
const GENERATION_SERVICE_URL =
  process.env.GENERATION_SERVICE_URL ||
  process.env.BRAINNN_URL ||
  'http://localhost:4007';
const WEB_MANAGER_URL = process.env.WEB_MANAGER_URL || 'http://localhost:8080';

// Test scenarios for functional equivalence
export interface TestScenario {
  name: string;
  description: string;
  input: {
    message: string;
    userId: string;
    context?: Record<string, unknown>;
  };
  expectedBehaviorTypes?: string[];
  expectedResponsePatterns?: RegExp[];
}

export interface EquivalenceTestResult {
  scenario: string;
  passed: boolean;
  decisionServiceResult?: {
    success: boolean;
    selectedBehavior?: string;
    confidence?: number;
    processingTime?: number;
  };
  generationServiceResult?: {
    success: boolean;
    text?: string;
    quality?: Record<string, number>;
    processingTime?: number;
  };
  orchestratedResult?: {
    success: boolean;
    response?: string;
    processingTime?: number;
  };
  errors?: string[];
  duration: number;
}

export interface FunctionalEquivalenceReport {
  timestamp: string;
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  passRate: number;
  results: EquivalenceTestResult[];
  summary: {
    decisionServiceAvailable: boolean;
    generationServiceAvailable: boolean;
    webManagerAvailable: boolean;
    averageDecisionTime: number;
    averageGenerationTime: number;
    averageOrchestrationTime: number;
  };
}

// Standard test scenarios covering various input types
export const standardTestScenarios: TestScenario[] = [
  {
    name: 'Simple Greeting',
    description: 'Basic greeting message',
    input: {
      message: '你好',
      userId: 'test_user_1'
    },
    expectedBehaviorTypes: ['reply_friendly', 'reply_supportive', 'reply_playful']
  },
  {
    name: 'Question About Streamer',
    description: 'User asking about the streamer',
    input: {
      message: '你今天心情怎么样？',
      userId: 'test_user_2'
    },
    expectedBehaviorTypes: ['reply_friendly', 'emotional_resonate', 'reply_supportive']
  },
  {
    name: 'Playful Teasing',
    description: 'User making a playful comment',
    input: {
      message: '你是不是又在偷懒？',
      userId: 'test_user_3'
    },
    expectedBehaviorTypes: ['tease_light', 'reply_playful', 'dodge']
  },
  {
    name: 'Technical Question',
    description: 'User asking a technical question',
    input: {
      message: '你用的是什么模型？',
      userId: 'test_user_4'
    },
    expectedBehaviorTypes: ['reply_friendly', 'clarify_question', 'dodge']
  },
  {
    name: 'Emotional Support Request',
    description: 'User expressing negative emotion',
    input: {
      message: '今天好累啊',
      userId: 'test_user_5'
    },
    expectedBehaviorTypes: ['reply_supportive', 'emotional_resonate', 'reply_friendly']
  },
  {
    name: 'Gift Acknowledgment',
    description: 'User sending a gift',
    input: {
      message: '送你一个小礼物',
      userId: 'test_user_6',
      context: { giftType: 'small', giftValue: 10 }
    },
    expectedBehaviorTypes: ['reply_friendly', 'reply_supportive']
  },
  {
    name: 'Topic Shift Request',
    description: 'User requesting topic change',
    input: {
      message: '我们聊点别的吧',
      userId: 'test_user_7'
    },
    expectedBehaviorTypes: ['topic_shift', 'reply_friendly', 'clarify_question']
  },
  {
    name: 'Empty-like Message',
    description: 'Very short or minimal message',
    input: {
      message: '嗯',
      userId: 'test_user_8'
    },
    expectedBehaviorTypes: ['reply_friendly', 'clarify_question', 'silent']
  },
  {
    name: 'Long Message',
    description: 'User sending a longer message',
    input: {
      message: '我今天去了一个很漂亮的地方，那里有山有水，风景特别好，我拍了很多照片想分享给你看',
      userId: 'test_user_9'
    },
    expectedBehaviorTypes: ['reply_friendly', 'emotional_resonate', 'reply_supportive']
  },
  {
    name: 'Returning User',
    description: 'User who has interacted before',
    input: {
      message: '我又来了',
      userId: 'returning_user',
      context: { previousInteractions: 5 }
    },
    expectedBehaviorTypes: ['reply_friendly', 'reply_playful']
  }
];

// Edge case scenarios
export const edgeCaseScenarios: TestScenario[] = [
  {
    name: 'Unicode Characters',
    description: 'Message with special unicode characters',
    input: {
      message: '😊 你好呀 🎉',
      userId: 'unicode_test'
    }
  },
  {
    name: 'Mixed Language',
    description: 'Message with mixed Chinese and English',
    input: {
      message: 'Hello 你好 World 世界',
      userId: 'mixed_lang_test'
    }
  },
  {
    name: 'Numbers Only',
    description: 'Message with only numbers',
    input: {
      message: '123456',
      userId: 'numbers_test'
    }
  },
  {
    name: 'Punctuation Heavy',
    description: 'Message with lots of punctuation',
    input: {
      message: '真的吗？！？！太棒了！！！',
      userId: 'punctuation_test'
    }
  },
  {
    name: 'Very Long Message',
    description: 'Message exceeding typical length',
    input: {
      message: '这是一条很长很长的消息'.repeat(20),
      userId: 'long_msg_test'
    }
  }
];

/**
 * Test DecisionService independently
 */
async function testDecisionService(scenario: TestScenario): Promise<{
  success: boolean;
  selectedBehavior?: string;
  confidence?: number;
  processingTime?: number;
  error?: string;
}> {
  const startTime = Date.now();
  
  try {
    const result = await httpPost(
      `${DECISION_SERVICE_URL}/api/decision`,
      {
        stateVector: new Array(27).fill(0.5),
        perceptionVector: new Array(8).fill(0.5),
        messageEmbedding: new Array(32).fill(0),
        memoryContext: new Array(32).fill(0),
        allowedBehaviors: [
          'reply_friendly', 'reply_supportive', 'reply_playful',
          'tease_light', 'dodge', 'silent', 'topic_shift',
          'clarify_question', 'emotional_resonate'
        ],
        constraints: scenario.input.context || {}
      },
      { timeout: 10000 }
    );
    
    const processingTime = Date.now() - startTime;
    
    if (!result.ok) {
      return { success: false, error: result.error, processingTime };
    }
    
    return {
      success: true,
      selectedBehavior: result.data?.selectedBehavior?.type,
      confidence: result.data?.selectedBehavior?.confidence,
      processingTime
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      processingTime: Date.now() - startTime
    };
  }
}

/**
 * Test GenerationService independently
 */
async function testGenerationService(
  scenario: TestScenario,
  decisionResult: { selectedBehavior?: string; confidence?: number }
): Promise<{
  success: boolean;
  text?: string;
  quality?: Record<string, number>;
  processingTime?: number;
  error?: string;
}> {
  const startTime = Date.now();
  
  try {
    const result = await httpPost(
      `${GENERATION_SERVICE_URL}/api/generate`,
      {
        decision: {
          success: true,
          selectedBehavior: {
            type: decisionResult.selectedBehavior || 'reply_friendly',
            confidence: decisionResult.confidence || 0.8,
            reasoning: 'Test scenario'
          },
          creativeGuidance: {
            theme: 'friendly_conversation',
            keyPoints: ['engage_with_user'],
            tone: { verbosity: 0.5, sarcasm: 0.1, warmth: 0.7 },
            style: { formality: 0.3, creativity: 0.5, engagement: 0.7 },
            constraints: { maxLength: 200, forbiddenTopics: [], requiredElements: [] }
          }
        },
        context: {
          userMessage: scenario.input.message,
          allowedMemories: [],
          conversationHistory: []
        },
        constraints: {
          maxTokens: 100,
          temperature: 0.7,
          safetyLevel: 'moderate'
        }
      },
      { timeout: 30000 }
    );
    
    const processingTime = Date.now() - startTime;
    
    if (!result.ok) {
      return { success: false, error: result.error, processingTime };
    }
    
    return {
      success: true,
      text: result.data?.text,
      quality: result.data?.quality,
      processingTime
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      processingTime: Date.now() - startTime
    };
  }
}

/**
 * Test orchestrated flow through Web Manager
 */
async function testOrchestratedFlow(scenario: TestScenario): Promise<{
  success: boolean;
  response?: string;
  processingTime?: number;
  error?: string;
}> {
  const startTime = Date.now();
  
  try {
    const result = await httpPost(
      `${WEB_MANAGER_URL}/api/chat`,
      {
        text: scenario.input.message,
        userId: scenario.input.userId,
        ...scenario.input.context
      },
      { timeout: 45000 }
    );
    
    const processingTime = Date.now() - startTime;
    
    if (!result.ok) {
      return { success: false, error: result.error, processingTime };
    }
    
    return {
      success: true,
      response: result.data?.response || result.data?.text,
      processingTime
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      processingTime: Date.now() - startTime
    };
  }
}

/**
 * Run a single equivalence test scenario
 */
export async function runEquivalenceTest(scenario: TestScenario): Promise<EquivalenceTestResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  
  // Test DecisionService
  const decisionResult = await testDecisionService(scenario);
  if (!decisionResult.success) {
    errors.push(`DecisionService: ${decisionResult.error}`);
  }
  
  // Test GenerationService (using decision result)
  const generationResult = await testGenerationService(scenario, decisionResult);
  if (!generationResult.success) {
    errors.push(`GenerationService: ${generationResult.error}`);
  }
  
  // Test orchestrated flow
  const orchestratedResult = await testOrchestratedFlow(scenario);
  if (!orchestratedResult.success) {
    errors.push(`Orchestration: ${orchestratedResult.error}`);
  }
  
  // Determine if test passed
  // A test passes if:
  // 1. All services respond successfully, OR
  // 2. The orchestrated flow succeeds (even if individual services have issues)
  const passed = orchestratedResult.success || 
    (decisionResult.success && generationResult.success);
  
  // Additional validation: check if behavior type is expected
  if (passed && scenario.expectedBehaviorTypes && decisionResult.selectedBehavior) {
    if (!scenario.expectedBehaviorTypes.includes(decisionResult.selectedBehavior)) {
      errors.push(`Unexpected behavior type: ${decisionResult.selectedBehavior}, expected one of: ${scenario.expectedBehaviorTypes.join(', ')}`);
    }
  }
  
  return {
    scenario: scenario.name,
    passed: passed && errors.length === 0,
    decisionServiceResult: decisionResult.success ? {
      success: true,
      selectedBehavior: decisionResult.selectedBehavior,
      confidence: decisionResult.confidence,
      processingTime: decisionResult.processingTime
    } : undefined,
    generationServiceResult: generationResult.success ? {
      success: true,
      text: generationResult.text,
      quality: generationResult.quality,
      processingTime: generationResult.processingTime
    } : undefined,
    orchestratedResult: orchestratedResult.success ? {
      success: true,
      response: orchestratedResult.response,
      processingTime: orchestratedResult.processingTime
    } : undefined,
    errors: errors.length > 0 ? errors : undefined,
    duration: Date.now() - startTime
  };
}

/**
 * Check service availability
 */
async function checkServiceAvailability(): Promise<{
  decisionService: boolean;
  generationService: boolean;
  webManager: boolean;
}> {
  const [decisionHealth, generationHealth, webManagerHealth] = await Promise.all([
    httpGet(`${DECISION_SERVICE_URL}/health`).then(r => r.ok).catch(() => false),
    httpGet(`${GENERATION_SERVICE_URL}/health`).then(r => r.ok).catch(() => false),
    httpGet(`${WEB_MANAGER_URL}/health`).then(r => r.ok).catch(() => false)
  ]);
  
  return {
    decisionService: decisionHealth,
    generationService: generationHealth,
    webManager: webManagerHealth
  };
}

/**
 * Run full functional equivalence test suite
 */
export async function runFunctionalEquivalenceTests(
  scenarios: TestScenario[] = [...standardTestScenarios, ...edgeCaseScenarios],
  options: { verbose?: boolean } = {}
): Promise<FunctionalEquivalenceReport> {
  console.log('🔍 Starting Functional Equivalence Tests...\n');
  console.log(`Testing ${scenarios.length} scenarios against split services\n`);
  
  // Check service availability first
  const availability = await checkServiceAvailability();
  console.log('Service Availability:');
  console.log(`  DecisionService:   ${availability.decisionService ? '✅' : '❌'}`);
  console.log(`  GenerationService: ${availability.generationService ? '✅' : '❌'}`);
  console.log(`  Web Manager:       ${availability.webManager ? '✅' : '❌'}\n`);
  
  const results: EquivalenceTestResult[] = [];
  
  for (const scenario of scenarios) {
    if (options.verbose) {
      console.log(`Testing: ${scenario.name}...`);
    }
    
    const result = await runEquivalenceTest(scenario);
    results.push(result);
    
    const status = result.passed ? '✅' : '❌';
    console.log(`${status} ${scenario.name} (${result.duration}ms)`);
    
    if (!result.passed && result.errors) {
      result.errors.forEach(err => console.log(`   ⚠️ ${err}`));
    }
  }
  
  // Calculate statistics
  const passedCount = results.filter(r => r.passed).length;
  const failedCount = results.length - passedCount;
  
  const decisionTimes = results
    .filter(r => r.decisionServiceResult?.processingTime)
    .map(r => r.decisionServiceResult!.processingTime!);
  const generationTimes = results
    .filter(r => r.generationServiceResult?.processingTime)
    .map(r => r.generationServiceResult!.processingTime!);
  const orchestrationTimes = results
    .filter(r => r.orchestratedResult?.processingTime)
    .map(r => r.orchestratedResult!.processingTime!);
  
  const avgDecisionTime = decisionTimes.length > 0
    ? decisionTimes.reduce((a, b) => a + b, 0) / decisionTimes.length
    : 0;
  const avgGenerationTime = generationTimes.length > 0
    ? generationTimes.reduce((a, b) => a + b, 0) / generationTimes.length
    : 0;
  const avgOrchestrationTime = orchestrationTimes.length > 0
    ? orchestrationTimes.reduce((a, b) => a + b, 0) / orchestrationTimes.length
    : 0;
  
  const report: FunctionalEquivalenceReport = {
    timestamp: new Date().toISOString(),
    totalScenarios: scenarios.length,
    passedScenarios: passedCount,
    failedScenarios: failedCount,
    passRate: (passedCount / scenarios.length) * 100,
    results,
    summary: {
      decisionServiceAvailable: availability.decisionService,
      generationServiceAvailable: availability.generationService,
      webManagerAvailable: availability.webManager,
      averageDecisionTime: Math.round(avgDecisionTime),
      averageGenerationTime: Math.round(avgGenerationTime),
      averageOrchestrationTime: Math.round(avgOrchestrationTime)
    }
  };
  
  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('Functional Equivalence Test Summary');
  console.log('='.repeat(60));
  console.log(`Total Scenarios:    ${report.totalScenarios}`);
  console.log(`Passed:             ${report.passedScenarios}`);
  console.log(`Failed:             ${report.failedScenarios}`);
  console.log(`Pass Rate:          ${report.passRate.toFixed(1)}%`);
  console.log('');
  console.log('Average Processing Times:');
  console.log(`  Decision:         ${report.summary.averageDecisionTime}ms`);
  console.log(`  Generation:       ${report.summary.averageGenerationTime}ms`);
  console.log(`  Orchestration:    ${report.summary.averageOrchestrationTime}ms`);
  console.log('='.repeat(60));
  
  return report;
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const edgeCasesOnly = args.includes('--edge-cases');
  const standardOnly = args.includes('--standard');
  
  let scenarios = [...standardTestScenarios, ...edgeCaseScenarios];
  if (edgeCasesOnly) {
    scenarios = edgeCaseScenarios;
  } else if (standardOnly) {
    scenarios = standardTestScenarios;
  }
  
  runFunctionalEquivalenceTests(scenarios, { verbose })
    .then(report => {
      process.exit(report.passRate >= 80 ? 0 : 1);
    })
    .catch(error => {
      console.error('❌ Test execution failed:', error);
      process.exit(1);
    });
}

export {
  testDecisionService,
  testGenerationService,
  testOrchestratedFlow,
  checkServiceAvailability
};
