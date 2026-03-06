/**
 * M5 每日报告生成器
 * 
 * 生成每日运营报告:
 * - 请求统计
 * - 延迟分析
 * - 错误汇总
 * - WorldState 趋势
 * - 建议改进
 */

import fs from 'fs';
import path from 'path';

const TRACE_PATH = process.env.COT_TRACE_PATH || path.resolve(process.cwd(), 'data/traces/cot_traces.jsonl');
const REPORTS_DIR = process.env.REPORTS_DIR || path.resolve(process.cwd(), 'reports/daily');
const POLICY_PATH = process.env.POLICY_MEMORY_PATH || path.resolve(process.cwd(), 'data/policy_memory.json');

function readTracesByDate(dateStr) {
    if (!fs.existsSync(TRACE_PATH)) {
        return [];
    }

    const content = fs.readFileSync(TRACE_PATH, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    return lines.map(line => {
        try {
            return JSON.parse(line);
        } catch {
            return null;
        }
    }).filter(t => {
        if (!t) return false;
        const traceDate = (t.timestamp || '').slice(0, 10);
        return traceDate === dateStr;
    });
}

function calculateStats(traces) {
    if (traces.length === 0) {
        return {
            totalRequests: 0,
            successfulRequests: 0,
            errorCount: 0,
            avgLatency: 0,
            p95Latency: 0,
            parseSuccessRate: 1,
            fallbackRate: 0,
        };
    }

    const latencies = traces
        .filter(t => t.latency_ms !== undefined)
        .map(t => t.latency_ms)
        .sort((a, b) => a - b);

    const successfulCount = traces.filter(t => t.parse_ok === true).length;
    const errorCount = traces.filter(t => t.parse_ok !== true).length;

    const fallbackPhrases = ['抱歉', '掉线', 'unavailable'];
    const fallbackCount = traces.filter(t => {
        const response = t.response || '';
        return fallbackPhrases.some(p => response.includes(p));
    }).length;

    const p95 = latencies.length > 0
        ? latencies[Math.ceil(latencies.length * 0.95) - 1]
        : 0;

    return {
        totalRequests: traces.length,
        successfulRequests: successfulCount,
        errorCount,
        avgLatency: latencies.length > 0
            ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
            : 0,
        p95Latency: p95,
        parseSuccessRate: successfulCount / traces.length,
        fallbackRate: fallbackCount / traces.length,
    };
}

function analyzeRoutes(traces) {
    const fastTraces = traces.filter(t => t.route === 'fast');
    const slowTraces = traces.filter(t => t.route === 'slow');

    const avgLatency = (arr) => {
        const latencies = arr.filter(t => t.latency_ms).map(t => t.latency_ms);
        return latencies.length > 0
            ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
            : 0;
    };

    return {
        fast: { count: fastTraces.length, avgLatency: avgLatency(fastTraces) },
        slow: { count: slowTraces.length, avgLatency: avgLatency(slowTraces) },
    };
}

function analyzeProviders(traces) {
    const providerMap = {};

    for (const t of traces) {
        const provider = t.llmProvider || t.llm_provider || 'unknown';
        if (!providerMap[provider]) {
            providerMap[provider] = { latencies: [], successes: 0, total: 0 };
        }
        if (t.latency_ms) providerMap[provider].latencies.push(t.latency_ms);
        if (t.parse_ok) providerMap[provider].successes++;
        providerMap[provider].total++;
    }

    const result = {};
    for (const [provider, data] of Object.entries(providerMap)) {
        result[provider] = {
            count: data.total,
            avgLatency: data.latencies.length > 0
                ? Math.round(data.latencies.reduce((a, b) => a + b, 0) / data.latencies.length)
                : 0,
            successRate: data.total > 0 ? data.successes / data.total : 0,
        };
    }

    return result;
}

function getTopErrors(traces) {
    const errorMap = {};

    for (const t of traces) {
        if (t.parse_ok === false && t.parse_error) {
            const error = t.parse_error.slice(0, 100);
            errorMap[error] = (errorMap[error] || 0) + 1;
        }
    }

    return Object.entries(errorMap)
        .map(([error, count]) => ({ error, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
}

function getPolicyStats() {
    let totalRules = 0;

    try {
        if (fs.existsSync(POLICY_PATH)) {
            const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf-8'));
            totalRules = (policy.rules || []).length;
        }
    } catch {
        // ignore
    }

    return { totalRules, newRules: 0 };
}

function generateRecommendations(report) {
    const recommendations = [];

    if (report.summary.parseSuccessRate < 0.95) {
        recommendations.push('⚠️ 解析成功率低于 95%，建议检查 LLM 输出格式');
    }

    if (report.summary.fallbackRate > 0.01) {
        recommendations.push('⚠️ Fallback 使用率偏高，建议检查服务稳定性');
    }

    if (report.summary.p95Latency > 5000) {
        recommendations.push('⚠️ P95 延迟过高，建议优化慢路由处理');
    }

    if (report.routeAnalysis.slow.count > report.routeAnalysis.fast.count * 2) {
        recommendations.push('💡 慢路由请求比例较高，考虑调整路由阈值');
    }

    if (report.summary.errorCount > 10) {
        recommendations.push(`🔴 发现 ${report.summary.errorCount} 个错误，建议查看错误日志`);
    }

    if (recommendations.length === 0) {
        recommendations.push('✅ 系统运行正常，无特殊建议');
    }

    return recommendations;
}

function renderMarkdown(report) {
    const lines = [];

    lines.push(`# Memory Suite 每日报告`);
    lines.push('');
    lines.push(`**日期**: ${report.date}`);
    lines.push(`**生成时间**: ${report.generatedAt}`);
    lines.push('');

    lines.push(`## 📊 概览`);
    lines.push('');
    lines.push(`| 指标 | 值 |`);
    lines.push(`|------|------|`);
    lines.push(`| 总请求数 | ${report.summary.totalRequests} |`);
    lines.push(`| 成功请求 | ${report.summary.successfulRequests} |`);
    lines.push(`| 错误数 | ${report.summary.errorCount} |`);
    lines.push(`| 平均延迟 | ${report.summary.avgLatency}ms |`);
    lines.push(`| P95 延迟 | ${report.summary.p95Latency}ms |`);
    lines.push(`| 解析成功率 | ${(report.summary.parseSuccessRate * 100).toFixed(2)}% |`);
    lines.push(`| Fallback 率 | ${(report.summary.fallbackRate * 100).toFixed(2)}% |`);
    lines.push('');

    lines.push(`## 🛤️ 路由分析`);
    lines.push('');
    lines.push(`| 路由 | 请求数 | 平均延迟 |`);
    lines.push(`|------|--------|----------|`);
    lines.push(`| Fast | ${report.routeAnalysis.fast.count} | ${report.routeAnalysis.fast.avgLatency}ms |`);
    lines.push(`| Slow | ${report.routeAnalysis.slow.count} | ${report.routeAnalysis.slow.avgLatency}ms |`);
    lines.push('');

    lines.push(`## 🤖 Provider 分析`);
    lines.push('');
    lines.push(`| Provider | 请求数 | 平均延迟 | 成功率 |`);
    lines.push(`|----------|--------|----------|--------|`);
    for (const [provider, data] of Object.entries(report.providerAnalysis)) {
        lines.push(`| ${provider} | ${data.count} | ${data.avgLatency}ms | ${(data.successRate * 100).toFixed(1)}% |`);
    }
    lines.push('');

    if (report.topErrors.length > 0) {
        lines.push(`## ❌ Top 错误`);
        lines.push('');
        for (const err of report.topErrors) {
            lines.push(`- [${err.count}次] ${err.error}`);
        }
        lines.push('');
    }

    lines.push(`## 📋 策略统计`);
    lines.push('');
    lines.push(`- 策略规则数: ${report.policyStats.totalRules}`);
    lines.push('');

    lines.push(`## 💡 建议`);
    lines.push('');
    for (const rec of report.recommendations) {
        lines.push(rec);
    }
    lines.push('');

    return lines.join('\n');
}

function main() {
    const today = new Date().toISOString().slice(0, 10);
    console.log(`=== 每日报告生成器 ===`);
    console.log(`日期: ${today}\n`);

    const traces = readTracesByDate(today);
    console.log(`读取到 ${traces.length} 条今日 trace 记录`);

    const report = {
        date: today,
        generatedAt: new Date().toISOString(),
        summary: calculateStats(traces),
        routeAnalysis: analyzeRoutes(traces),
        providerAnalysis: analyzeProviders(traces),
        topErrors: getTopErrors(traces),
        policyStats: getPolicyStats(),
        recommendations: [],
    };

    report.recommendations = generateRecommendations(report);

    if (!fs.existsSync(REPORTS_DIR)) {
        fs.mkdirSync(REPORTS_DIR, { recursive: true });
    }

    const jsonPath = path.join(REPORTS_DIR, `report-${today}.json`);
    const mdPath = path.join(REPORTS_DIR, `report-${today}.md`);

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
    fs.writeFileSync(mdPath, renderMarkdown(report), 'utf-8');

    console.log(`\n报告已生成:`);
    console.log(`  JSON: ${jsonPath}`);
    console.log(`  Markdown: ${mdPath}`);

    console.log(`\n=== 摘要 ===`);
    console.log(`总请求: ${report.summary.totalRequests}`);
    console.log(`成功率: ${(report.summary.parseSuccessRate * 100).toFixed(2)}%`);
    console.log(`平均延迟: ${report.summary.avgLatency}ms`);

    if (report.recommendations.length > 0) {
        console.log(`\n建议:`);
        report.recommendations.forEach(r => console.log(`  ${r}`));
    }
}

main();
