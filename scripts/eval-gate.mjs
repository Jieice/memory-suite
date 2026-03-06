/**
 * M4 Eval Gate + 自动回滚
 * 
 * 流程:
 * 1. 运行 eval:intelligence 评估
 * 2. 对比新适配器与基线的分数
 * 3. 如果改进 -> 推广新适配器
 * 4. 如果退化 -> 回滚到上一版本
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const CONFIG = {
    adapterDir: process.env.QLORA_ADAPTER_DIR || path.resolve(process.cwd(), 'data/adapters'),
    evalScript: process.env.EVAL_SCRIPT || path.resolve(process.cwd(), 'scripts/run-intelligence-eval.mjs'),
    evalDataset: process.env.EVAL_DATASET || path.resolve(process.cwd(), 'eval/intelligence/dataset.v2.json'),
    reportsDir: process.env.EVAL_REPORTS_DIR || path.resolve(process.cwd(), 'reports/intelligence'),
    minImprovement: parseFloat(process.env.EVAL_MIN_IMPROVEMENT || '2.0'),
    minPassRate: parseFloat(process.env.EVAL_MIN_PASS_RATE || '0.8'),
    sloRequired: process.env.EVAL_SLO_REQUIRED !== 'false',
};

interface EvalResult {
    avgScore: number;
    passRate: number;
    sloVerdict: 'pass' | 'fail';
    total: number;
    passed: number;
}

interface AdapterInfo {
    path: string;
    timestamp: string;
    evalResult?: EvalResult;
}

interface GateResult {
    approved: boolean;
    reason: string;
    newAdapter: string | null;
    rolledBack: boolean;
    baselineScore: number | null;
    newScore: number | null;
}

function getLatestEvalReport(): { path: string; data: any } | null {
    if (!fs.existsSync(CONFIG.reportsDir)) {
        return null;
    }

    const files = fs.readdirSync(CONFIG.reportsDir)
        .filter(f => f.startsWith('intelligence-eval-') && f.endsWith('.json'))
        .sort()
        .reverse();

    if (files.length === 0) {
        return null;
    }

    const latestPath = path.join(CONFIG.reportsDir, files[0]);
    try {
        const data = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
        return { path: latestPath, data };
    } catch {
        return null;
    }
}

function extractEvalResult(report: any): EvalResult {
    const summary = report?.summary || {};
    return {
        avgScore: summary.avgScore || 0,
        passRate: summary.passRate || 0,
        sloVerdict: summary.slo?.verdict || 'fail',
        total: summary.total || 0,
        passed: summary.passed || 0,
    };
}

function getBaselineEval(): EvalResult | null {
    const baselinePath = path.join(CONFIG.reportsDir, 'baseline.json');
    if (fs.existsSync(baselinePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
            return extractEvalResult(data);
        } catch {
            return null;
        }
    }
    return null;
}

function runEval(): EvalResult | null {
    console.log('[EvalGate] 运行评估...');

    try {
        execSync(`node "${CONFIG.evalScript}" --dataset "${CONFIG.evalDataset}"`, {
            stdio: 'inherit',
            timeout: 300000,
        });
    } catch (err: any) {
        console.error('[EvalGate] 评估执行失败:', err.message);
        return null;
    }

    const report = getLatestEvalReport();
    if (!report) {
        console.error('[EvalGate] 未找到评估报告');
        return null;
    }

    return extractEvalResult(report.data);
}

function getAdapters(): AdapterInfo[] {
    if (!fs.existsSync(CONFIG.adapterDir)) {
        return [];
    }

    const adapters: AdapterInfo[] = [];
    const dirs = fs.readdirSync(CONFIG.adapterDir, { withFileTypes: true });

    for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        if (!dir.name.startsWith('adapter-')) continue;

        const adapterPath = path.join(CONFIG.adapterDir, dir.name);
        const manifestPath = path.join(adapterPath, 'adapter_config.json');

        if (fs.existsSync(manifestPath)) {
            adapters.push({
                path: adapterPath,
                timestamp: dir.name.replace('adapter-', ''),
            });
        }
    }

    return adapters.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function getCurrentAdapter(): string | null {
    const latestPath = path.join(CONFIG.adapterDir, 'latest.json');
    if (fs.existsSync(latestPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
            return data.adapterPath || null;
        } catch {
            return null;
        }
    }
    return null;
}

function setCurrentAdapter(adapterPath: string): void {
    const latestPath = path.join(CONFIG.adapterDir, 'latest.json');
    const data = {
        timestamp: new Date().toISOString(),
        adapterPath,
        approved: true,
    };
    fs.writeFileSync(latestPath, JSON.stringify(data, null, 2), 'utf-8');
}

function rollback(): string | null {
    const adapters = getAdapters();
    if (adapters.length < 2) {
        console.log('[EvalGate] 没有可回滚的适配器');
        return null;
    }

    const previousAdapter = adapters[1];
    setCurrentAdapter(previousAdapter.path);
    console.log(`[EvalGate] 已回滚到: ${previousAdapter.path}`);
    return previousAdapter.path;
}

function compareResults(baseline: EvalResult, newResult: EvalResult): {
    improved: boolean;
    scoreDelta: number;
    passRateDelta: number;
} {
    const scoreDelta = newResult.avgScore - baseline.avgScore;
    const passRateDelta = newResult.passRate - baseline.passRate;

    const improved = scoreDelta >= CONFIG.minImprovement || 
        (newResult.passRate >= CONFIG.minPassRate && scoreDelta >= 0);

    return { improved, scoreDelta, passRateDelta };
}

async function main(): Promise<void> {
    console.log('=== M4 Eval Gate + 自动回滚 ===\n');

    const newAdapter = getCurrentAdapter();
    if (!newAdapter) {
        console.log('[EvalGate] 没有新适配器需要评估');
        return;
    }

    console.log(`[EvalGate] 新适配器: ${newAdapter}`);

    const baseline = getBaselineEval();
    if (baseline) {
        console.log(`[EvalGate] 基线分数: ${baseline.avgScore.toFixed(2)}, 通过率: ${(baseline.passRate * 100).toFixed(1)}%`);
    } else {
        console.log('[EvalGate] 没有基线评估，将创建基线');
    }

    const newResult = runEval();
    if (!newResult) {
        console.error('[EvalGate] 评估失败');
        const rolledBack = rollback();
        console.log(`\n=== Gate 结果 ===`);
        console.log(`批准: false`);
        console.log(`原因: 评估执行失败`);
        console.log(`回滚: ${rolledBack ? '成功' : '无可用回滚'}`);
        process.exit(1);
    }

    console.log(`[EvalGate] 新评估分数: ${newResult.avgScore.toFixed(2)}, 通过率: ${(newResult.passRate * 100).toFixed(1)}%`);
    console.log(`[EvalGate] SLO 判定: ${newResult.sloVerdict.toUpperCase()}`);

    if (CONFIG.sloRequired && newResult.sloVerdict !== 'pass') {
        console.log('[EvalGate] SLO 未通过，执行回滚');
        const rolledBack = rollback();
        console.log(`\n=== Gate 结果 ===`);
        console.log(`批准: false`);
        console.log(`原因: SLO 未通过`);
        console.log(`回滚: ${rolledBack ? '成功' : '无可用回滚'}`);
        process.exit(1);
    }

    if (!baseline) {
        const baselinePath = path.join(CONFIG.reportsDir, 'baseline.json');
        const latestReport = getLatestEvalReport();
        if (latestReport) {
            fs.writeFileSync(baselinePath, JSON.stringify(latestReport.data, null, 2), 'utf-8');
            console.log(`[EvalGate] 已创建基线: ${baselinePath}`);
        }
        console.log(`\n=== Gate 结果 ===`);
        console.log(`批准: true`);
        console.log(`原因: 首次评估，已创建基线`);
        process.exit(0);
    }

    const comparison = compareResults(baseline, newResult);
    console.log(`[EvalGate] 分数变化: ${comparison.scoreDelta >= 0 ? '+' : ''}${comparison.scoreDelta.toFixed(2)}`);
    console.log(`[EvalGate] 通过率变化: ${comparison.passRateDelta >= 0 ? '+' : ''}${(comparison.passRateDelta * 100).toFixed(1)}%`);

    const gateResult: GateResult = {
        approved: comparison.improved,
        reason: comparison.improved ? '性能改进' : '性能退化',
        newAdapter: comparison.improved ? newAdapter : null,
        rolledBack: false,
        baselineScore: baseline.avgScore,
        newScore: newResult.avgScore,
    };

    if (!comparison.improved) {
        console.log('[EvalGate] 性能退化，执行回滚');
        const rolledBack = rollback();
        gateResult.rolledBack = !!rolledBack;
    } else {
        console.log('[EvalGate] 性能改进，推广新适配器');
        setCurrentAdapter(newAdapter);
    }

    const resultPath = path.join(CONFIG.adapterDir, 'gate-result.json');
    fs.writeFileSync(resultPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        ...gateResult,
    }, null, 2), 'utf-8');

    console.log(`\n=== Gate 结果 ===`);
    console.log(`批准: ${gateResult.approved}`);
    console.log(`原因: ${gateResult.reason}`);
    console.log(`基线分数: ${gateResult.baselineScore?.toFixed(2)}`);
    console.log(`新分数: ${gateResult.newScore?.toFixed(2)}`);
    console.log(`回滚: ${gateResult.rolledBack}`);
    console.log(`结果文件: ${resultPath}`);

    process.exit(gateResult.approved ? 0 : 1);
}

main().catch(console.error);
