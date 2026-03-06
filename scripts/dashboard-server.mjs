/**
 * M5 监控仪表盘 API
 * 
 * 提供实时监控数据:
 * - 延迟统计 (P50/P95/P99)
 * - 解析成功率
 * - Fallback 使用率
 * - 资源使用情况
 * - WorldState 快照
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import url from 'url';

const PORT = parseInt(process.env.DASHBOARD_PORT || '4020', 10);
const TRACE_PATH = process.env.COT_TRACE_PATH || path.resolve(process.cwd(), 'data/traces/cot_traces.jsonl');

function readRecentTraces(maxLines = 1000) {
    if (!fs.existsSync(TRACE_PATH)) {
        return [];
    }

    const content = fs.readFileSync(TRACE_PATH, 'utf-8');
    const lines = content.split('\n').filter(Boolean).slice(-maxLines);

    return lines.map(line => {
        try {
            return JSON.parse(line);
        } catch {
            return null;
        }
    }).filter(Boolean);
}

function calculateLatencyStats(traces) {
    const latencies = traces
        .filter(t => t.latency_ms !== undefined)
        .map(t => t.latency_ms)
        .sort((a, b) => a - b);

    if (latencies.length === 0) {
        return { p50: 0, p95: 0, p99: 0, avg: 0 };
    }

    const percentile = (arr, p) => {
        const idx = Math.ceil(arr.length * p) - 1;
        return arr[Math.max(0, Math.min(idx, arr.length - 1))];
    };

    return {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    };
}

function calculateParseSuccessRate(traces) {
    if (traces.length === 0) return 1;
    const successCount = traces.filter(t => t.parse_ok === true).length;
    return successCount / traces.length;
}

function calculateFallbackRate(traces) {
    if (traces.length === 0) return 0;
    const fallbackPhrases = ['抱歉', '掉线', 'unavailable'];
    const fallbackCount = traces.filter(t => {
        const response = t.response || '';
        return fallbackPhrases.some(p => response.includes(p));
    }).length;
    return fallbackCount / traces.length;
}

function calculateRouteDistribution(traces) {
    let fast = 0, slow = 0;
    for (const t of traces) {
        if (t.route === 'fast') fast++;
        else if (t.route === 'slow') slow++;
    }
    return { fast, slow };
}

function calculateProviderDistribution(traces) {
    const dist = {};
    for (const t of traces) {
        const provider = t.llmProvider || t.llm_provider || 'unknown';
        dist[provider] = (dist[provider] || 0) + 1;
    }
    return dist;
}

function getSystemMetrics() {
    const usage = process.memoryUsage();
    const uptime = process.uptime();

    return {
        cpu: 0,
        memory: Math.round(usage.heapUsed / 1024 / 1024),
        uptime: Math.round(uptime),
    };
}

function getMetrics() {
    const traces = readRecentTraces(1000);

    return {
        timestamp: new Date().toISOString(),
        latency: calculateLatencyStats(traces),
        parseSuccessRate: calculateParseSuccessRate(traces),
        fallbackRate: calculateFallbackRate(traces),
        requestCount: traces.length,
        errorCount: traces.filter(t => !t.parse_ok).length,
        routeDistribution: calculateRouteDistribution(traces),
        providerDistribution: calculateProviderDistribution(traces),
    };
}

function getWorldStateSnapshot() {
    return {
        activity: '杂谈',
        atmosphere: 0.5,
        danmaku_density_10s: 0,
        hot_topics_300s: [],
        audience_pulse: 0.5,
    };
}

function generateDashboardHTML(metrics) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Memory Suite Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; padding: 20px; }
        .header { text-align: center; margin-bottom: 30px; }
        .header h1 { color: #00d9ff; font-size: 2em; }
        .header .timestamp { color: #888; font-size: 0.9em; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .card { background: #16213e; border-radius: 12px; padding: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        .card h2 { color: #00d9ff; font-size: 1.1em; margin-bottom: 15px; border-bottom: 1px solid #333; padding-bottom: 10px; }
        .metric { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #222; }
        .metric:last-child { border-bottom: none; }
        .metric-label { color: #aaa; }
        .metric-value { font-weight: bold; font-family: monospace; }
        .metric-value.good { color: #4ade80; }
        .metric-value.warn { color: #fbbf24; }
        .metric-value.bad { color: #f87171; }
        .latency-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; text-align: center; }
        .latency-item { background: #0f3460; padding: 15px; border-radius: 8px; }
        .latency-label { font-size: 0.8em; color: #888; }
        .latency-value { font-size: 1.5em; font-weight: bold; color: #00d9ff; }
        .progress-bar { height: 8px; background: #333; border-radius: 4px; overflow: hidden; margin-top: 5px; }
        .progress-fill { height: 100%; background: #00d9ff; transition: width 0.3s; }
        .route-bar { display: flex; height: 20px; border-radius: 4px; overflow: hidden; margin-top: 10px; }
        .route-fast { background: #4ade80; }
        .route-slow { background: #fbbf24; }
        .refresh-btn { position: fixed; bottom: 20px; right: 20px; background: #00d9ff; color: #1a1a2e; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-weight: bold; }
        .refresh-btn:hover { background: #00b8d9; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🧠 Memory Suite Dashboard</h1>
        <div class="timestamp">Last updated: ${metrics.timestamp}</div>
    </div>

    <div class="grid">
        <div class="card">
            <h2>⏱️ Latency</h2>
            <div class="latency-grid">
                <div class="latency-item">
                    <div class="latency-label">P50</div>
                    <div class="latency-value">${metrics.latency.p50}ms</div>
                </div>
                <div class="latency-item">
                    <div class="latency-label">P95</div>
                    <div class="latency-value">${metrics.latency.p95}ms</div>
                </div>
                <div class="latency-item">
                    <div class="latency-label">P99</div>
                    <div class="latency-value">${metrics.latency.p99}ms</div>
                </div>
                <div class="latency-item">
                    <div class="latency-label">AVG</div>
                    <div class="latency-value">${metrics.latency.avg}ms</div>
                </div>
            </div>
        </div>

        <div class="card">
            <h2>📊 Parse Success</h2>
            <div class="metric">
                <span class="metric-label">Success Rate</span>
                <span class="metric-value ${(metrics.parseSuccessRate * 100).toFixed(1) >= 95 ? 'good' : 'warn'}">${(metrics.parseSuccessRate * 100).toFixed(2)}%</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${metrics.parseSuccessRate * 100}%"></div>
            </div>
            <div class="metric">
                <span class="metric-label">Total Requests</span>
                <span class="metric-value">${metrics.requestCount}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Parse Errors</span>
                <span class="metric-value ${metrics.errorCount > 0 ? 'bad' : 'good'}">${metrics.errorCount}</span>
            </div>
        </div>

        <div class="card">
            <h2>🔄 Fallback Rate</h2>
            <div class="metric">
                <span class="metric-label">Fallback Usage</span>
                <span class="metric-value ${metrics.fallbackRate < 0.01 ? 'good' : metrics.fallbackRate < 0.05 ? 'warn' : 'bad'}">${(metrics.fallbackRate * 100).toFixed(2)}%</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${Math.min(metrics.fallbackRate * 100, 100)}%; background: ${metrics.fallbackRate < 0.01 ? '#4ade80' : metrics.fallbackRate < 0.05 ? '#fbbf24' : '#f87171'}"></div>
            </div>
        </div>

        <div class="card">
            <h2>🛤️ Route Distribution</h2>
            <div class="metric">
                <span class="metric-label">Fast Route</span>
                <span class="metric-value good">${metrics.routeDistribution.fast}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Slow Route</span>
                <span class="metric-value warn">${metrics.routeDistribution.slow}</span>
            </div>
            <div class="route-bar">
                <div class="route-fast" style="width: ${metrics.routeDistribution.fast / (metrics.requestCount || 1) * 100}%"></div>
                <div class="route-slow" style="width: ${metrics.routeDistribution.slow / (metrics.requestCount || 1) * 100}%"></div>
            </div>
        </div>

        <div class="card">
            <h2>🤖 Provider Distribution</h2>
            ${Object.entries(metrics.providerDistribution).map(([provider, count]) => `
            <div class="metric">
                <span class="metric-label">${provider}</span>
                <span class="metric-value">${count}</span>
            </div>
            `).join('')}
        </div>

        <div class="card">
            <h2>💻 System</h2>
            <div class="metric">
                <span class="metric-label">Memory (Heap)</span>
                <span class="metric-value">${getSystemMetrics().memory} MB</span>
            </div>
            <div class="metric">
                <span class="metric-label">Uptime</span>
                <span class="metric-value">${Math.floor(getSystemMetrics().uptime / 60)} min</span>
            </div>
        </div>
    </div>

    <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
    <script>setTimeout(() => location.reload(), 30000);</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url || '/', true);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (parsedUrl.pathname === '/api/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getMetrics()));
        return;
    }

    if (parsedUrl.pathname === '/api/worldstate') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getWorldStateSnapshot()));
        return;
    }

    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(generateDashboardHTML(getMetrics()));
});

server.listen(PORT, () => {
    console.log(`[Dashboard] 监控仪表盘已启动: http://localhost:${PORT}`);
    console.log(`[Dashboard] API 端点:`);
    console.log(`  - GET /api/metrics - 获取指标数据`);
    console.log(`  - GET /api/worldstate - 获取 WorldState 快照`);
    console.log(`  - GET /health - 健康检查`);
});

process.on('SIGINT', () => {
    console.log('\n[Dashboard] 正在关闭...');
    server.close();
    process.exit(0);
});
