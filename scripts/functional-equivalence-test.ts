/**
 * Unified runtime regression suite.
 *
 * This file keeps the original export surface so existing property tests still
 * compile, but the executable behavior is now aligned to the unified Rust
 * runtime instead of the retired split-service topology.
 */

import { httpGet, httpPost } from '../shared/httpClient';

const UNIFIED_RUNTIME_URL =
  process.env.MEMORY_SUITE_URL ||
  process.env.WEB_MANAGER_URL ||
  process.env.MEMORY_UNIVERSE_URL ||
  'http://localhost:8080';

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
  }
];

export const edgeCaseScenarios: TestScenario[] = [
  {
    name: 'Unicode Characters',
    description: 'Message with special unicode characters',
    input: {
      message: '😊 你好呀 🎀',
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
      message: '真的吗？！太棒了！！！',
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

async function testDecisionService(): Promise<{
  success: boolean;
  selectedBehavior?: string;
  confidence?: number;
  processingTime?: number;
  error?: string;
}> {
  return {
    success: false,
    error: 'Retired: direct DecisionService checks were removed with the unified Rust runtime.'
  };
}

async function testGenerationService(): Promise<{
  success: boolean;
  text?: string;
  quality?: Record<string, number>;
  processingTime?: number;
  error?: string;
}> {
  return {
    success: false,
    error: 'Retired: direct GenerationService checks were removed with the unified Rust runtime.'
  };
}

async function testOrchestratedFlow(scenario: TestScenario): Promise<{
  success: boolean;
  response?: string;
  processingTime?: number;
  error?: string;
}> {
  const startTime = Date.now();

  try {
    const result = await httpPost(
      `${UNIFIED_RUNTIME_URL}/api/chat`,
      {
        session_id: `equivalence-${scenario.input.userId}`,
        user_id: scenario.input.userId,
        text: scenario.input.message,
        metadata: scenario.input.context || {}
      },
      { timeout: 45000 }
    );

    const processingTime = Date.now() - startTime;

    if (!result.ok) {
      return { success: false, error: result.error, processingTime };
    }

    return {
      success: true,
      response: result.data?.response_text || result.data?.response || result.data?.text,
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

export async function runEquivalenceTest(scenario: TestScenario): Promise<EquivalenceTestResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  const decisionResult = await testDecisionService();
  const generationResult = await testGenerationService();
  const orchestratedResult = await testOrchestratedFlow(scenario);

  if (!orchestratedResult.success) {
    errors.push(`Unified runtime orchestration: ${orchestratedResult.error}`);
  }

  if (orchestratedResult.success && scenario.expectedResponsePatterns) {
    for (const pattern of scenario.expectedResponsePatterns) {
      if (!pattern.test(orchestratedResult.response || '')) {
        errors.push(`Response did not match expected pattern: ${pattern}`);
      }
    }
  }

  return {
    scenario: scenario.name,
    passed: orchestratedResult.success && errors.length === 0,
    decisionServiceResult: decisionResult.success
      ? {
          success: true,
          selectedBehavior: decisionResult.selectedBehavior,
          confidence: decisionResult.confidence,
          processingTime: decisionResult.processingTime
        }
      : undefined,
    generationServiceResult: generationResult.success
      ? {
          success: true,
          text: generationResult.text,
          quality: generationResult.quality,
          processingTime: generationResult.processingTime
        }
      : undefined,
    orchestratedResult: orchestratedResult.success
      ? {
          success: true,
          response: orchestratedResult.response,
          processingTime: orchestratedResult.processingTime
        }
      : undefined,
    errors: errors.length > 0 ? errors : undefined,
    duration: Date.now() - startTime
  };
}

async function checkServiceAvailability(): Promise<{
  decisionService: boolean;
  generationService: boolean;
  webManager: boolean;
}> {
  const unifiedHealth = await httpGet(`${UNIFIED_RUNTIME_URL}/api/health`)
    .then(result => result.ok)
    .catch(() => false);

  return {
    decisionService: false,
    generationService: false,
    webManager: unifiedHealth
  };
}

export async function runFunctionalEquivalenceTests(
  scenarios: TestScenario[] = [...standardTestScenarios, ...edgeCaseScenarios],
  options: { verbose?: boolean } = {}
): Promise<FunctionalEquivalenceReport> {
  console.log('Starting unified runtime regression checks...\n');
  console.log(`Testing ${scenarios.length} scenarios against the unified runtime\n`);

  const availability = await checkServiceAvailability();
  console.log('Service Availability:');
  console.log(`  Unified runtime: ${availability.webManager ? 'up' : 'down'}`);
  console.log('  DecisionService: retired');
  console.log('  GenerationService: retired\n');

  const results: EquivalenceTestResult[] = [];

  for (const scenario of scenarios) {
    if (options.verbose) {
      console.log(`Testing: ${scenario.name}...`);
    }

    const result = await runEquivalenceTest(scenario);
    results.push(result);
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${scenario.name} (${result.duration}ms)`);

    if (!result.passed && result.errors) {
      result.errors.forEach(error => console.log(`   - ${error}`));
    }
  }

  const passedCount = results.filter(result => result.passed).length;
  const failedCount = results.length - passedCount;
  const orchestrationTimes = results
    .filter(result => result.orchestratedResult?.processingTime)
    .map(result => result.orchestratedResult!.processingTime!);
  const avgOrchestrationTime =
    orchestrationTimes.length > 0
      ? orchestrationTimes.reduce((sum, value) => sum + value, 0) / orchestrationTimes.length
      : 0;

  return {
    timestamp: new Date().toISOString(),
    totalScenarios: scenarios.length,
    passedScenarios: passedCount,
    failedScenarios: failedCount,
    passRate: scenarios.length === 0 ? 100 : (passedCount / scenarios.length) * 100,
    results,
    summary: {
      decisionServiceAvailable: false,
      generationServiceAvailable: false,
      webManagerAvailable: availability.webManager,
      averageDecisionTime: 0,
      averageGenerationTime: 0,
      averageOrchestrationTime: Math.round(avgOrchestrationTime)
    }
  };
}

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
      console.error('Regression execution failed:', error);
      process.exit(1);
    });
}

export { testDecisionService, testGenerationService, testOrchestratedFlow, checkServiceAvailability };
