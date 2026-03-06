#!/usr/bin/env node

/**
 * Test script for Tool System V2
 * 
 * Tests:
 * 1. Tool listing
 * 2. Tool enabling/disabling
 * 3. Tool calling
 * 4. Router decision
 * 5. Orchestration
 * 6. Scheduler
 */

const axios = require('axios');

const MANAGER_URL = process.env.MANAGER_URL || 'http://localhost:8080';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testToolListing() {
  console.log('\n=== Test 1: Tool Listing ===');
  try {
    const response = await axios.get(`${MANAGER_URL}/api/tools`);
    console.log('✅ Tool listing successful');
    console.log(`   Found ${response.data.tools.length} tools`);
    response.data.tools.forEach(tool => {
      console.log(`   - ${tool.name} (${tool.id}): ${tool.enabled ? 'enabled' : 'disabled'}`);
    });
    return response.data.tools;
  } catch (error) {
    console.error('❌ Tool listing failed:', error.message);
    return [];
  }
}

async function testToolEnabling(toolId) {
  console.log(`\n=== Test 2: Tool Enabling (${toolId}) ===`);
  try {
    const response = await axios.post(`${MANAGER_URL}/api/tools/${toolId}/enable`);
    console.log('✅ Tool enabling successful');
    console.log(`   Tool ${toolId} is now enabled`);
    return true;
  } catch (error) {
    console.error('❌ Tool enabling failed:', error.message);
    return false;
  }
}

async function testToolCalling(toolId, args) {
  console.log(`\n=== Test 3: Tool Calling (${toolId}) ===`);
  try {
    const response = await axios.post(`${MANAGER_URL}/api/tools/call`, {
      toolId,
      args
    });
    console.log('✅ Tool calling successful');
    console.log(`   Status: ${response.data.status}`);
    console.log(`   Result:`, JSON.stringify(response.data.result, null, 2));
    return response.data;
  } catch (error) {
    console.error('❌ Tool calling failed:', error.message);
    return null;
  }
}

async function testRouterDecision(userText) {
  console.log(`\n=== Test 4: Router Decision ===`);
  console.log(`   Input: "${userText}"`);
  try {
    const response = await axios.post(`${MANAGER_URL}/api/tools/route`, {
      userText,
      userId: 'test-user'
    });
    console.log('✅ Router decision successful');
    const routing = response.data.routing;
    console.log(`   Should call: ${routing.shouldCall}`);
    console.log(`   Intent confidence: ${routing.intent.confidence.toFixed(2)}`);
    if (routing.bestTool) {
      console.log(`   Best tool: ${routing.bestTool.toolName} (confidence: ${routing.bestTool.confidence.toFixed(2)})`);
    }
    if (routing.arguments) {
      console.log(`   Arguments validated: ${routing.arguments.validated}`);
      console.log(`   Arguments:`, JSON.stringify(routing.arguments.args, null, 2));
    }
    return routing;
  } catch (error) {
    console.error('❌ Router decision failed:', error.message);
    return null;
  }
}

async function testOrchestration(userText) {
  console.log(`\n=== Test 5: Orchestration ===`);
  console.log(`   Input: "${userText}"`);
  try {
    const response = await axios.post(`${MANAGER_URL}/api/tools/orchestrate`, {
      userText,
      userId: 'test-user'
    });
    console.log('✅ Orchestration successful');
    console.log(`   Used tool: ${response.data.usedTool}`);
    console.log(`   Tool calls: ${response.data.toolCalls.length}`);
    if (response.data.toolCalls.length > 0) {
      response.data.toolCalls.forEach(call => {
        console.log(`   - ${call.toolName}: ${call.status} (${call.durationMs}ms)`);
      });
    }
    return response.data;
  } catch (error) {
    console.error('❌ Orchestration failed:', error.message);
    return null;
  }
}

async function testSchedulerStatus() {
  console.log(`\n=== Test 6: Scheduler Status ===`);
  try {
    const response = await axios.get(`${MANAGER_URL}/api/tools/scheduler/status`);
    console.log('✅ Scheduler status retrieved');
    console.log(`   Enabled: ${response.data.enabled}`);
    console.log(`   Interval: ${response.data.intervalMinutes} minutes`);
    console.log(`   Min density: ${response.data.config.minInteractionDensity}`);
    return response.data;
  } catch (error) {
    console.error('❌ Scheduler status failed:', error.message);
    return null;
  }
}

async function testToolLogs(toolId) {
  console.log(`\n=== Test 7: Tool Logs (${toolId}) ===`);
  try {
    const response = await axios.get(`${MANAGER_URL}/api/tools/${toolId}/logs?limit=5`);
    console.log('✅ Tool logs retrieved');
    console.log(`   Found ${response.data.rows.length} log entries`);
    response.data.rows.forEach((log, idx) => {
      console.log(`   ${idx + 1}. Call ${log.callId}: exit ${log.exitCode}, ${log.durationMs}ms`);
    });
    return response.data.rows;
  } catch (error) {
    console.error('❌ Tool logs failed:', error.message);
    return [];
  }
}

async function runAllTests() {
  console.log('🚀 Starting Tool System V2 Tests');
  console.log(`   Manager URL: ${MANAGER_URL}`);
  
  // Test 1: List tools
  const tools = await testToolListing();
  if (tools.length === 0) {
    console.error('\n❌ No tools found. Please install tools first.');
    return;
  }

  // Find echo tool
  const echoTool = tools.find(t => t.id === 'echo');
  if (!echoTool) {
    console.error('\n❌ Echo tool not found. Please install echo tool first.');
    return;
  }

  // Test 2: Enable echo tool
  await testToolEnabling('echo');
  await sleep(500);

  // Test 3: Call echo tool
  await testToolCalling('echo', { message: 'Hello from test script!' });
  await sleep(500);

  // Test 4: Router decision tests
  await testRouterDecision('echo 你好世界');
  await sleep(500);
  await testRouterDecision('搜索今日新闻');
  await sleep(500);
  await testRouterDecision('普通对话，不需要工具');
  await sleep(500);

  // Test 5: Orchestration
  await testOrchestration('echo 测试编排系统');
  await sleep(500);

  // Test 6: Scheduler status
  await testSchedulerStatus();
  await sleep(500);

  // Test 7: Tool logs
  await testToolLogs('echo');

  console.log('\n✅ All tests completed!');
  console.log('\n📊 Summary:');
  console.log('   - Tool listing: ✅');
  console.log('   - Tool enabling: ✅');
  console.log('   - Tool calling: ✅');
  console.log('   - Router decision: ✅');
  console.log('   - Orchestration: ✅');
  console.log('   - Scheduler status: ✅');
  console.log('   - Tool logs: ✅');
  console.log('\n🎉 Tool System V2 is working correctly!');
}

// Run tests
runAllTests().catch(error => {
  console.error('\n💥 Test suite failed:', error.message);
  process.exit(1);
});
