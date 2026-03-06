/**
 * M3 持续学习 v1 - 从 CoT traces 提取策略记忆
 * 
 * 输入: data/traces/cot_traces.jsonl
 * 输出: 
 *   - data/policy_memory.json
 *   - data/taboo_rules.json
 */

import fs from 'fs';
import path from 'path';

const TRACE_PATH = process.env.COT_TRACE_PATH || path.resolve(process.cwd(), 'data/traces/cot_traces.jsonl');
const BAD_TRACE_PATH = process.env.COT_BAD_TRACE_PATH || path.resolve(process.cwd(), 'data/traces/bad_cot_samples.jsonl');
const POLICY_OUTPUT = process.env.POLICY_MEMORY_PATH || path.resolve(process.cwd(), 'data/policy_memory.json');
const TABOO_OUTPUT = process.env.TABOO_RULES_PATH || path.resolve(process.cwd(), 'data/taboo_rules.json');

const MIN_CONFIDENCE = parseFloat(process.env.POLICY_MIN_CONFIDENCE || '0.6');
const MIN_SAMPLES = parseInt(process.env.POLICY_MIN_SAMPLES || '3', 10);

const DANGER_PATTERNS = [
    { pattern: /政治|台独|藏独|疆独|港独|反华|反政府/i, severity: 'high' },
    { pattern: /色情|裸体|性交|做爱/i, severity: 'high' },
    { pattern: /暴力|杀人|自杀|炸弹|恐怖/i, severity: 'high' },
    { pattern: /敏感|被封|被封杀|被封禁/i, severity: 'medium' },
    { pattern: /辱华|辱国|汉奸|卖国/i, severity: 'high' },
];

const INTENT_PATTERNS = [
    { pattern: /问候|打招呼|你好|嗨|哈喽/i, intent: 'greeting' },
    { pattern: /提问|问|什么|怎么|为什么|如何/i, intent: 'question' },
    { pattern: /调侃|玩梗|梗|笑话|搞笑/i, intent: 'teasing' },
    { pattern: /表白|喜欢|爱|心动/i, intent: 'confession' },
    { pattern: /抱怨|吐槽|不满|无聊/i, intent: 'complaint' },
    { pattern: /感谢|谢谢|感谢/i, intent: 'gratitude' },
    { pattern: /命令|指令|控制|操作/i, intent: 'command' },
];

function readTraces(filePath) {
    if (!fs.existsSync(filePath)) {
        return [];
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').filter(Boolean).map(line => {
        try {
            return JSON.parse(line);
        } catch {
            return null;
        }
    }).filter(Boolean);
}

function extractIntent(text) {
    for (const { pattern, intent } of INTENT_PATTERNS) {
        if (pattern.test(text)) {
            return intent;
        }
    }
    return null;
}

function checkDangerContent(text) {
    for (const { pattern, severity } of DANGER_PATTERNS) {
        if (pattern.test(text)) {
            return { isDanger: true, severity };
        }
    }
    return { isDanger: false, severity: 'low' };
}

function extractPolicyRules(traces) {
    const intentGroups = new Map();

    for (const trace of traces) {
        if (!trace.parse_ok || !trace.thinking || !trace.response) continue;

        const confidence = trace.thinking.confidence ?? 0.5;
        if (confidence < MIN_CONFIDENCE) continue;

        const intent = extractIntent(trace.input_text) || 'general';
        const strategy = trace.thinking.social_strategy;
        const response = trace.response;

        if (!intentGroups.has(intent)) {
            intentGroups.set(intent, { strategies: [], responses: [], confidences: [] });
        }
        const group = intentGroups.get(intent);
        group.strategies.push(strategy);
        group.responses.push(response);
        group.confidences.push(confidence);
    }

    const rules = [];

    for (const [intent, group] of intentGroups.entries()) {
        if (group.strategies.length < MIN_SAMPLES) continue;

        const avgConfidence = group.confidences.reduce((a, b) => a + b, 0) / group.confidences.length;
        const uniqueStrategies = [...new Set(group.strategies)].slice(0, 3);
        const guidance = uniqueStrategies.join('; ');

        rules.push({
            pattern: intent,
            guidance,
            confidence: Math.round(avgConfidence * 1000) / 1000,
            sampleCount: group.strategies.length,
            examples: group.responses.slice(0, 5),
            lastUpdated: new Date().toISOString(),
        });
    }

    return rules.sort((a, b) => b.sampleCount - a.sampleCount);
}

function extractTabooRules(badTraces, goodTraces) {
    const tabooMap = new Map();

    for (const trace of badTraces) {
        const danger = checkDangerContent(trace.input_text);
        if (danger.isDanger) {
            const key = danger.severity === 'high' ? 'dangerous_content' : 'sensitive_content';
            if (!tabooMap.has(key)) {
                tabooMap.set(key, { count: 0, examples: [], severities: [] });
            }
            const entry = tabooMap.get(key);
            entry.count++;
            entry.severities.push(danger.severity);
            if (entry.examples.length < 5) {
                entry.examples.push(trace.input_text.slice(0, 100));
            }
        }
    }

    for (const trace of goodTraces) {
        if (!trace.parse_ok || !trace.thinking) continue;

        const danger = checkDangerContent(trace.input_text);
        if (danger.isDanger) {
            const key = 'dangerous_input_handled';
            if (!tabooMap.has(key)) {
                tabooMap.set(key, { count: 0, examples: [], severities: [] });
            }
            const entry = tabooMap.get(key);
            entry.count++;
            entry.severities.push('medium');
            if (entry.examples.length < 5) {
                entry.examples.push(trace.input_text.slice(0, 100));
            }
        }
    }

    const rules = [];

    for (const [trigger, data] of tabooMap.entries()) {
        if (data.count < MIN_SAMPLES) continue;

        const maxSeverity = data.severities.reduce((max, s) => {
            if (s === 'high') return 'high';
            if (s === 'medium' && max !== 'high') return 'medium';
            return max;
        }, 'low');

        let avoidance = '避免直接回应敏感话题，转移话题或礼貌拒绝';
        if (trigger === 'dangerous_content') {
            avoidance = '严格拒绝，不提供任何可能有害的信息';
        } else if (trigger === 'dangerous_input_handled') {
            avoidance = '已成功处理，记录为正面案例';
        }

        rules.push({
            trigger,
            avoidance,
            severity: maxSeverity,
            sampleCount: data.count,
            examples: data.examples,
            lastUpdated: new Date().toISOString(),
        });
    }

    return rules.sort((a, b) => {
        const severityOrder = { high: 0, medium: 1, low: 2 };
        return severityOrder[a.severity] - severityOrder[b.severity];
    });
}

function main() {
    console.log('=== M3 持续学习 v1 - 策略提取 ===\n');
    console.log(`CoT Traces: ${TRACE_PATH}`);
    console.log(`Bad Traces: ${BAD_TRACE_PATH}`);
    console.log(`Policy Output: ${POLICY_OUTPUT}`);
    console.log(`Taboo Output: ${TABOO_OUTPUT}\n`);

    const traces = readTraces(TRACE_PATH);
    const badTraces = readTraces(BAD_TRACE_PATH);

    console.log(`成功解析 traces: ${traces.length}`);
    console.log(`失败 traces: ${badTraces.length}\n`);

    const validTraces = traces.filter(t => t.parse_ok && t.thinking && t.response);
    console.log(`有效 traces (parse_ok + thinking + response): ${validTraces.length}`);

    const highConfidenceTraces = validTraces.filter(t => (t.thinking?.confidence ?? 0) >= MIN_CONFIDENCE);
    console.log(`高置信度 traces (>= ${MIN_CONFIDENCE}): ${highConfidenceTraces.length}\n`);

    console.log('提取策略规则...');
    const policyRules = extractPolicyRules(traces);
    console.log(`提取到 ${policyRules.length} 条策略规则\n`);

    console.log('提取禁忌规则...');
    const tabooRules = extractTabooRules(badTraces, traces);
    console.log(`提取到 ${tabooRules.length} 条禁忌规则\n`);

    const policyMemory = {
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        totalSamples: traces.length,
        rules: policyRules,
    };

    const tabooRulesData = {
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        totalSamples: badTraces.length,
        rules: tabooRules,
    };

    const policyDir = path.dirname(POLICY_OUTPUT);
    if (!fs.existsSync(policyDir)) {
        fs.mkdirSync(policyDir, { recursive: true });
    }

    fs.writeFileSync(POLICY_OUTPUT, JSON.stringify(policyMemory, null, 2), 'utf-8');
    console.log(`✅ 策略记忆已保存: ${POLICY_OUTPUT}`);

    fs.writeFileSync(TABOO_OUTPUT, JSON.stringify(tabooRulesData, null, 2), 'utf-8');
    console.log(`✅ 禁忌规则已保存: ${TABOO_OUTPUT}`);

    console.log('\n=== 提取完成 ===');
    console.log(`策略规则: ${policyRules.length} 条`);
    console.log(`禁忌规则: ${tabooRules.length} 条`);

    if (policyRules.length > 0) {
        console.log('\n策略规则预览:');
        for (const rule of policyRules.slice(0, 3)) {
            console.log(`  [${rule.pattern}] ${rule.guidance.slice(0, 50)}... (${rule.sampleCount} samples)`);
        }
    }

    if (tabooRules.length > 0) {
        console.log('\n禁忌规则预览:');
        for (const rule of tabooRules.slice(0, 3)) {
            console.log(`  [${rule.severity}] ${rule.trigger}: ${rule.avoidance.slice(0, 50)}...`);
        }
    }
}

main();
