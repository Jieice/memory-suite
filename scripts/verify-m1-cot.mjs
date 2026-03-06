/**
 * M1 CoT Hard Contract 验证脚本
 * 快速测试 CoT JSON 解析和 trace 写入功能
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.MANAGER_URL || 'http://127.0.0.1:8080';
const TRACE_PATH = path.resolve(process.cwd(), 'data/traces/cot_traces.jsonl');
const BAD_TRACE_PATH = path.resolve(process.cwd(), 'data/traces/bad_cot_samples.jsonl');

const TEST_MESSAGES = [
    { text: '你好', expectedKeywords: ['你好', '嗨', '哈喽'] },
    { text: '今天天气怎么样？', expectedKeywords: ['天气', '晴', '雨', '阴'] },
    { text: '讲个笑话吧', expectedKeywords: ['笑话', '好笑', '哈哈'] },
    { text: '你喜欢吃什么？', expectedKeywords: ['喜欢', '吃', '食物'] },
    { text: '你在做什么？', expectedKeywords: ['做', '正在', '忙'] },
];

async function sendChat(text, userId) {
    try {
        const response = await axios.post(`${BASE_URL}/api/chat`, {
            text,
            userId,
            userName: `m1_test_${userId}`,
            source: 'm1_verification',
        }, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' },
        });
        return response.data;
    } catch (error) {
        return {
            success: false,
            error: error.message || String(error),
        };
    }
}

function readTraces() {
    if (!fs.existsSync(TRACE_PATH)) {
        return [];
    }
    const content = fs.readFileSync(TRACE_PATH, 'utf-8');
    return content.split('\n').filter(Boolean).map(line => {
        try {
            return JSON.parse(line);
        } catch {
            return null;
        }
    }).filter(Boolean);
}

async function main() {
    console.log('=== M1 CoT Hard Contract 验证 ===\n');
    console.log(`API URL: ${BASE_URL}`);
    console.log(`Trace Path: ${TRACE_PATH}\n`);

    const startTime = Date.now();
    const results = {
        total: 0,
        success: 0,
        error: 0,
        parseOk: 0,
        parseFail: 0,
    };

    const existingTraces = readTraces();
    const existingCount = existingTraces.length;
    console.log(`现有 trace 记录数: ${existingCount}\n`);

    console.log('发送测试消息...');
    for (let i = 0; i < TEST_MESSAGES.length; i++) {
        const test = TEST_MESSAGES[i];
        const userId = `m1_verify_${i}`;
        
        console.log(`  [${i + 1}/${TEST_MESSAGES.length}] "${test.text}"`);
        const response = await sendChat(test.text, userId);
        
        results.total++;
        if (response.success) {
            results.success++;
            console.log(`    ✓ 成功: ${response.response?.substring(0, 50)}...`);
        } else {
            results.error++;
            console.log(`    ✗ 失败: ${response.error}`);
        }
        
        await new Promise(r => setTimeout(r, 500));
    }

    console.log('\n等待 trace 写入...');
    await new Promise(r => setTimeout(r, 2000));

    const newTraces = readTraces();
    const addedCount = newTraces.length - existingCount;
    console.log(`新增 trace 记录数: ${addedCount}\n`);

    for (const trace of newTraces.slice(existingCount)) {
        if (trace.parse_ok) {
            results.parseOk++;
        } else {
            results.parseFail++;
            console.log(`  解析失败: ${trace.parse_error}`);
        }
    }

    const elapsed = Date.now() - startTime;
    const parseRate = results.total > 0 ? (results.parseOk / results.total * 100) : 0;
    const successRate = results.total > 0 ? (results.success / results.total * 100) : 0;

    console.log('\n=== 验证结果 ===');
    console.log(`总测试数: ${results.total}`);
    console.log(`API 成功率: ${successRate.toFixed(1)}% (${results.success}/${results.total})`);
    console.log(`CoT 解析成功率: ${parseRate.toFixed(1)}% (${results.parseOk}/${results.total})`);
    console.log(`耗时: ${elapsed}ms`);

    const m1Passed = parseRate >= 95 && successRate >= 90;
    console.log(`\nM1 验收标准 (>= 95% 解析成功): ${m1Passed ? '✅ 通过' : '❌ 未通过'}`);

    if (fs.existsSync(BAD_TRACE_PATH)) {
        const badTraces = fs.readFileSync(BAD_TRACE_PATH, 'utf-8').split('\n').filter(Boolean);
        if (badTraces.length > 0) {
            console.log(`\n⚠️ 发现 ${badTraces.length} 条解析失败样本，请查看: ${BAD_TRACE_PATH}`);
        }
    }

    process.exit(m1Passed ? 0 : 1);
}

main().catch(err => {
    console.error('验证失败:', err);
    process.exit(1);
});
