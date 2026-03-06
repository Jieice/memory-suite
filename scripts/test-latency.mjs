/**
 * Memory Suite 延迟测试
 * 测试各模块的响应时间，识别性能瓶颈
 * 
 * 使用: node scripts/test-latency.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const BASE_URL = process.env.MEMORY_UNIVERSE_URL || 'http://localhost:4005';
const ITERATIONS = parseInt(process.env.ITERATIONS || '5', 10);

const tests = [
    { name: 'Evo-Memory Stats', endpoint: '/api/evo-memory/stats', method: 'GET', category: 'memory' },
    { name: 'Evo-Memory Strategies', endpoint: '/api/evo-memory/strategies', method: 'GET', category: 'memory' },
    { name: 'Mem0 Stats', endpoint: '/api/mem0/stats', method: 'GET', category: 'memory' },
    { name: 'Mem0 Search', endpoint: '/api/mem0/search?query=test', method: 'GET', category: 'memory' },
    { name: 'Mem0 Facts', endpoint: '/api/mem0/facts', method: 'GET', category: 'memory' },
    { name: 'Vision Status', endpoint: '/api/vision/status', method: 'GET', category: 'vision' },
    { name: 'Visual Memory Stats', endpoint: '/api/visual-memory/stats', method: 'GET', category: 'vision' },
    { name: 'Visual Memory Recent', endpoint: '/api/visual-memory/recent?count=5', method: 'GET', category: 'vision' },
    { name: 'Transparent Memory Stats', endpoint: '/api/transparent-memory/stats', method: 'GET', category: 'memory' },
    { name: 'Transparent Memory Files', endpoint: '/api/transparent-memory/files', method: 'GET', category: 'memory' },
    { name: 'MemoryR1 Stats', endpoint: '/api/memory-r1/stats', method: 'GET', category: 'memory' },
    { name: 'MemoryR1 Weights', endpoint: '/api/memory-r1/weights', method: 'GET', category: 'memory' },
    { name: 'Memory Stats (Core)', endpoint: '/api/memory/stats', method: 'GET', category: 'core' },
    { name: 'Memory Dream', endpoint: '/api/memory/dream', method: 'POST', category: 'core' },
    { name: 'Health Check', endpoint: '/health', method: 'GET', category: 'core' },
];

const thresholds = {
    fast: 100,      // 快速: < 100ms
    normal: 500,    // 正常: < 500ms
    slow: 2000,     // 慢: < 2000ms
    verySlow: 5000, // 很慢: < 5000ms
};

function getStatusIcon(avg) {
    if (avg < 0) return '❌';
    if (avg < thresholds.fast) return '🚀';
    if (avg < thresholds.normal) return '✅';
    if (avg < thresholds.slow) return '⚡';
    if (avg < thresholds.verySlow) return '⚠️';
    return '🔴';
}

function getStatusText(avg) {
    if (avg < 0) return 'FAILED';
    if (avg < thresholds.fast) return 'FAST';
    if (avg < thresholds.normal) return 'OK';
    if (avg < thresholds.slow) return 'SLOW';
    if (avg < thresholds.verySlow) return 'VERY_SLOW';
    return 'CRITICAL';
}

async function measureLatency(test) {
    const times = [];
    let lastError = null;
    
    for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now();
        
        try {
            const response = await fetch(`${BASE_URL}${test.endpoint}`, {
                method: test.method,
                headers: { 'Content-Type': 'application/json' },
                body: test.body ? JSON.stringify(test.body) : undefined,
                signal: AbortSignal.timeout(30000),
            });
            
            const end = performance.now();
            
            if (response.ok) {
                times.push(end - start);
            } else {
                lastError = `HTTP ${response.status}`;
                times.push(-1);
            }
        } catch (err) {
            lastError = err.message;
            times.push(-1);
        }
        
        // 避免请求过快
        if (i < ITERATIONS - 1) {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    
    const validTimes = times.filter(t => t >= 0);
    const successRate = validTimes.length / ITERATIONS;
    
    if (validTimes.length === 0) {
        return {
            name: test.name,
            category: test.category,
            status: 'FAILED',
            error: lastError,
            avg: -1,
            min: -1,
            max: -1,
            p95: -1,
            successRate: 0,
        };
    }
    
    validTimes.sort((a, b) => a - b);
    const avg = validTimes.reduce((a, b) => a + b, 0) / validTimes.length;
    const min = validTimes[0];
    const max = validTimes[validTimes.length - 1];
    const p95 = validTimes[Math.floor(validTimes.length * 0.95)] || validTimes[validTimes.length - 1];
    
    return {
        name: test.name,
        category: test.category,
        status: getStatusText(avg),
        avg,
        min,
        max,
        p95,
        successRate,
    };
}

async function main() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║           Memory Suite v2 延迟测试                         ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    console.log(`目标服务: ${BASE_URL}`);
    console.log(`迭代次数: ${ITERATIONS}`);
    console.log(`测试时间: ${new Date().toLocaleString('zh-CN')}\n`);
    
    // 检查服务是否运行
    try {
        const health = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
        if (!health.ok) {
            console.log('⚠️ 服务健康检查失败，部分测试可能失败');
        }
    } catch {
        console.log('❌ 服务未运行！请先启动 memory-universe 服务:');
        console.log('   cd memory-universe && npm run dev\n');
        process.exit(1);
    }
    
    const results = [];
    const categories = {};
    
    for (const test of tests) {
        process.stdout.write(`  测试 ${test.name.padEnd(25)} ... `);
        const result = await measureLatency(test);
        results.push(result);
        
        if (!categories[result.category]) {
            categories[result.category] = [];
        }
        categories[result.category].push(result);
        
        if (result.status === 'FAILED') {
            console.log('❌ FAILED');
        } else {
            console.log(`${getStatusIcon(result.avg)} ${result.avg.toFixed(0)}ms`);
        }
    }
    
    // 按类别汇总
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                      结果汇总                              ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    for (const [category, catResults] of Object.entries(categories)) {
        console.log(`\n[${category.toUpperCase()}]`);
        console.log('┌────────────────────────┬────────┬────────┬────────┬────────┬────────┐');
        console.log('│ 模块                   │ 平均   │ 最小   │ 最大   │ P95    │ 状态   │');
        console.log('├────────────────────────┼────────┼────────┼────────┼────────┼────────┤');
        
        for (const r of catResults) {
            const name = r.name.slice(0, 22).padEnd(22);
            if (r.status === 'FAILED') {
                console.log(`│ ${name} │ ${'FAILED'.padStart(6)} │ ${'-'.padStart(6)} │ ${'-'.padStart(6)} │ ${'-'.padStart(6)} │ ❌     │`);
            } else {
                const icon = getStatusIcon(r.avg);
                console.log(`│ ${name} │ ${r.avg.toFixed(0).padStart(5)}ms │ ${r.min.toFixed(0).padStart(5)}ms │ ${r.max.toFixed(0).padStart(5)}ms │ ${r.p95.toFixed(0).padStart(5)}ms │ ${icon}     │`);
            }
        }
        console.log('└────────────────────────┴────────┴────────┴────────┴────────┴────────┘');
    }
    
    // 性能问题汇总
    const slowModules = results.filter(r => r.avg > thresholds.normal && r.status !== 'FAILED');
    const failedModules = results.filter(r => r.status === 'FAILED');
    
    if (slowModules.length > 0 || failedModules.length > 0) {
        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║                      问题汇总                              ║');
        console.log('╚════════════════════════════════════════════════════════════╝\n');
        
        if (slowModules.length > 0) {
            console.log('⚠️  高延迟模块 (>500ms):');
            for (const m of slowModules.sort((a, b) => b.avg - a.avg)) {
                console.log(`   - ${m.name}: ${m.avg.toFixed(0)}ms`);
            }
        }
        
        if (failedModules.length > 0) {
            console.log('\n❌ 失败模块:');
            for (const m of failedModules) {
                console.log(`   - ${m.name}: ${m.error || '未知错误'}`);
            }
        }
    }
    
    // 性能建议
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                      性能建议                              ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    const avgLatency = results.filter(r => r.avg > 0).reduce((a, b) => a + b.avg, 0) / results.filter(r => r.avg > 0).length;
    
    if (avgLatency < thresholds.fast) {
        console.log('✅ 整体性能优秀！所有模块响应迅速。');
    } else if (avgLatency < thresholds.normal) {
        console.log('✅ 整体性能良好，大部分模块响应正常。');
    } else if (avgLatency < thresholds.slow) {
        console.log('⚠️  整体性能一般，建议优化以下方面:');
        console.log('   1. 检查数据库/文件 I/O 是否有瓶颈');
        console.log('   2. 考虑增加缓存层');
        console.log('   3. 检查是否有阻塞操作');
    } else {
        console.log('🔴 整体性能较差，需要立即优化:');
        console.log('   1. 检查服务资源是否充足');
        console.log('   2. 检查是否有内存泄漏');
        console.log('   3. 考虑异步处理耗时操作');
    }
    
    // 保存报告
    const reportDir = path.join(ROOT_DIR, 'data');
    if (!fs.existsSync(reportDir)) {
        fs.mkdirSync(reportDir, { recursive: true });
    }
    
    const reportPath = path.join(reportDir, 'latency-report.json');
    const report = {
        timestamp: new Date().toISOString(),
        baseUrl: BASE_URL,
        iterations: ITERATIONS,
        summary: {
            total: results.length,
            passed: results.filter(r => r.status !== 'FAILED').length,
            failed: failedModules.length,
            slow: slowModules.length,
            avgLatency,
        },
        thresholds,
        results,
    };
    
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 报告已保存: ${reportPath}`);
}

main().catch(err => {
    console.error('\n❌ 测试执行失败:', err);
    process.exit(1);
});
