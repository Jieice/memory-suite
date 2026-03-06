/**
 * 直播压力测试脚本
 * 模拟每秒几十条消息，持续3小时的直播场景
 */

import axios from 'axios';
import { performance } from 'perf_hooks';

interface StressTestConfig {
    messagesPerSecond: number;      // 每秒消息数（默认30）
    durationHours: number;         // 持续时间（默认3）
    concurrentUsers: number;       // 并发用户数（默认10）
    messageTemplates: string[];    // 消息模板
    enableStreaming: boolean;       // 是否测试流式
    enableProactive: boolean;       // 是否测试主动发言
    baseUrl: string;               // API基础URL
    userIdPrefix: string;          // 用户ID前缀
}

interface Metrics {
    totalMessages: number;
    successCount: number;
    errorCount: number;
    responseTimes: number[];
    ttfb: number[]; // Time to First Byte
    errors: Array<{ time: number; error: string; userId: string }>;
    startTime: number;
    endTime?: number;
}

interface TestResults {
    testDuration: string;
    totalMessages: number;
    successRate: number;
    avgResponseTime: number;
    avgTTFB: number;
    p50ResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    maxResponseTime: number;
    minResponseTime: number;
    errors: number;
    errorRate: number;
    qps: number; // 每秒查询数
    peakMemoryMB?: number;
    peakCPUPercent?: number;
}

const DEFAULT_MESSAGE_TEMPLATES = [
    '你好',
    '今天天气怎么样？',
    '你在做什么？',
    '讲个笑话吧',
    '你最喜欢什么？',
    '介绍一下你自己',
    '今天心情怎么样？',
    '有什么有趣的事情吗？',
    '你会唱歌吗？',
    '你多大了？',
    '你住在哪里？',
    '你最喜欢吃什么？',
    '你会玩游戏吗？',
    '你有什么特长？',
    '你最近在学什么？',
];

class LiveStressTest {
    private config: StressTestConfig;
    private metrics: Metrics;
    private isRunning = false;
    private userSessions: Map<string, { lastMessageTime: number }> = new Map();

    constructor(config: Partial<StressTestConfig> = {}) {
        this.config = {
            messagesPerSecond: config.messagesPerSecond || 30,
            durationHours: config.durationHours || 3,
            concurrentUsers: config.concurrentUsers || 10,
            messageTemplates: config.messageTemplates || DEFAULT_MESSAGE_TEMPLATES,
            enableStreaming: config.enableStreaming || false,
            enableProactive: config.enableProactive || false,
            baseUrl: config.baseUrl || 'http://localhost:8080', // Changed default to localhost:8080 as per instruction's implied default
            userIdPrefix: config.userIdPrefix || 'stress_test_user_',
        };

        this.metrics = {
            totalMessages: 0,
            successCount: 0,
            errorCount: 0,
            responseTimes: [],
            ttfb: [],
            errors: [],
            startTime: Date.now(),
        };
    }

    /**
     * 运行压力测试
     */
    async run(): Promise<TestResults> {
        console.log('🚀 开始压力测试...');
        console.log(`配置: ${this.config.messagesPerSecond}条/秒, ${this.config.durationHours}小时, ${this.config.concurrentUsers}个并发用户`);

        this.isRunning = true;
        this.metrics.startTime = Date.now();

        const durationMs = this.config.durationHours * 60 * 60 * 1000;
        const intervalMs = 1000 / this.config.messagesPerSecond;
        const endTime = this.metrics.startTime + durationMs;

        // 启动并发用户
        const userPromises: Promise<void>[] = [];
        for (let i = 0; i < this.config.concurrentUsers; i++) {
            const userId = `${this.config.userIdPrefix}${i}`;
            this.userSessions.set(userId, { lastMessageTime: 0 });
            userPromises.push(this.simulateUser(userId, endTime, intervalMs));
        }

        // 等待所有用户完成
        await Promise.all(userPromises);

        this.isRunning = false;
        this.metrics.endTime = Date.now();

        return this.generateReport();
    }

    /**
     * 模拟单个用户
     */
    private async simulateUser(userId: string, endTime: number, intervalMs: number): Promise<void> {
        const session = this.userSessions.get(userId)!;
        let lastSendTime = 0;

        while (this.isRunning && Date.now() < endTime) {
            const now = Date.now();
            const timeSinceLastSend = now - lastSendTime;

            // 控制发送频率
            if (timeSinceLastSend < intervalMs * this.config.concurrentUsers) {
                await this.sleep(intervalMs * this.config.concurrentUsers - timeSinceLastSend);
                continue;
            }

            await this.sendMessage(userId);
            lastSendTime = Date.now();

            // 随机延迟，模拟真实用户行为
            const randomDelay = Math.random() * intervalMs * 0.5;
            await this.sleep(randomDelay);
        }
    }

    /**
     * 发送消息
     */
    private async sendMessage(userId: string): Promise<void> {
        const template = this.config.messageTemplates[
            Math.floor(Math.random() * this.config.messageTemplates.length)
        ];
        const message = `${template} [${userId}]`;

        const startTime = performance.now();
        try {
            if (this.config.enableStreaming) {
                await this.sendStreamingMessage(userId, message);
            } else {
                await this.sendNormalMessage(userId, message);
            }

            const responseTime = performance.now() - startTime;
            this.metrics.responseTimes.push(responseTime);
            this.metrics.successCount++;
            this.metrics.totalMessages++;

            // 每100条消息打印一次进度
            if (this.metrics.totalMessages % 100 === 0) {
                const elapsed = (Date.now() - this.metrics.startTime) / 1000;
                const qps = this.metrics.totalMessages / elapsed;
                console.log(
                    `[进度] 已发送: ${this.metrics.totalMessages}, ` +
                    `成功: ${this.metrics.successCount}, ` +
                    `失败: ${this.metrics.errorCount}, ` +
                    `QPS: ${qps.toFixed(2)}, ` +
                    `平均响应: ${(this.metrics.responseTimes.slice(-100).reduce((a, b) => a + b, 0) / 100).toFixed(0)}ms`
                );
            }
        } catch (error: any) {
            const responseTime = performance.now() - startTime;
            this.metrics.errorCount++;
            this.metrics.totalMessages++;
            this.metrics.errors.push({
                time: Date.now(),
                error: error.message || String(error),
                userId,
            });

            console.error(`[错误] ${userId}: ${error.message || error}`);
        }
    }

    /**
     * 发送普通消息
     */
    private async sendNormalMessage(userId: string, text: string): Promise<void> {
        const response = await axios.post(
            `${this.config.baseUrl}/api/chat`,
            {
                text,
                userId,
                userName: `测试用户_${userId}`,
                source: 'stress_test',
            },
            {
                timeout: 30000,
                headers: {
                    'Content-Type': 'application/json',
                },
            }
        );

        if (!response.data || !response.data.success) {
            throw new Error(`API返回失败: ${JSON.stringify(response.data)}`);
        }
    }

    /**
     * 发送流式消息
     */
    private async sendStreamingMessage(userId: string, text: string): Promise<void> {
        return new Promise(async (resolve, reject) => {
            try {
                const startTime = performance.now();
                let firstByteReceived = false;

                const response = await axios.post(
                    `${this.config.baseUrl}/api/chat/stream`,
                    {
                        text,
                        userId,
                        userName: `测试用户_${userId}`,
                        source: 'stress_test',
                    },
                    {
                        responseType: 'stream',
                        timeout: 30000,
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'text/event-stream',
                        },
                    }
                );

                const stream = response.data;
                let receivedData = '';

                stream.on('data', (chunk: Buffer) => {
                    if (!firstByteReceived) {
                        firstByteReceived = true;
                        const ttfb = performance.now() - startTime;
                        this.metrics.ttfb.push(ttfb);
                    }
                    receivedData += chunk.toString();
                });

                stream.on('end', () => {
                    if (receivedData.length > 0) {
                        resolve();
                    } else {
                        reject(new Error('Empty stream response'));
                    }
                });

                stream.on('error', (err: any) => {
                    reject(err);
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * 生成测试报告
     */
    private generateReport(): TestResults {
        const duration = (this.metrics.endTime! - this.metrics.startTime) / 1000;
        const durationHours = duration / 3600;
        const sortedTimes = [...this.metrics.responseTimes].sort((a, b) => a - b);

        const getPercentile = (p: number): number => {
            if (sortedTimes.length === 0) return 0;
            const index = Math.floor(sortedTimes.length * p);
            return sortedTimes[Math.min(index, sortedTimes.length - 1)];
        };

        const avgResponseTime = sortedTimes.length > 0
            ? sortedTimes.reduce((a, b) => a + b, 0) / sortedTimes.length
            : 0;

        const avgTTFB = this.metrics.ttfb.length > 0
            ? this.metrics.ttfb.reduce((a, b) => a + b, 0) / this.metrics.ttfb.length
            : 0;

        const qps = this.metrics.totalMessages / duration;

        return {
            testDuration: `${durationHours.toFixed(2)}h`,
            totalMessages: this.metrics.totalMessages,
            successRate: this.metrics.totalMessages > 0
                ? this.metrics.successCount / this.metrics.totalMessages
                : 0,
            avgResponseTime: Math.round(avgResponseTime),
            avgTTFB: Math.round(avgTTFB),
            p50ResponseTime: Math.round(getPercentile(0.5)),
            p95ResponseTime: Math.round(getPercentile(0.95)),
            p99ResponseTime: Math.round(getPercentile(0.99)),
            maxResponseTime: sortedTimes.length > 0 ? Math.round(sortedTimes[sortedTimes.length - 1]) : 0,
            minResponseTime: sortedTimes.length > 0 ? Math.round(sortedTimes[0]) : 0,
            errors: this.metrics.errorCount,
            errorRate: this.metrics.totalMessages > 0
                ? this.metrics.errorCount / this.metrics.totalMessages
                : 0,
            qps: Math.round(qps * 100) / 100,
        };
    }

    /**
     * 打印测试报告
     */
    printReport(results: TestResults): void {
        console.log('\n' + '='.repeat(60));
        console.log('📊 压力测试报告');
        console.log('='.repeat(60));
        console.log(`测试时长: ${results.testDuration}`);
        console.log(`总消息数: ${results.totalMessages}`);
        console.log(`成功率: ${(results.successRate * 100).toFixed(2)}%`);
        console.log(`错误数: ${results.errors} (${(results.errorRate * 100).toFixed(2)}%)`);
        console.log(`QPS: ${results.qps}`);
        console.log('\n响应时间统计:');
        console.log(`  平均: ${results.avgResponseTime}ms`);
        if (results.avgTTFB > 0) console.log(`  平均TTFB: ${results.avgTTFB}ms`);
        console.log(`  P50: ${results.p50ResponseTime}ms`);
        console.log(`  P95: ${results.p95ResponseTime}ms`);
        console.log(`  P99: ${results.p99ResponseTime}ms`);
        console.log(`  最小: ${results.minResponseTime}ms`);
        console.log(`  最大: ${results.maxResponseTime}ms`);
        console.log('='.repeat(60) + '\n');
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// 主函数
async function main() {
    const args = process.argv.slice(2);
    const config: Partial<StressTestConfig> = {};

    // 解析命令行参数
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i]?.replace('--', '');
        const value = args[i + 1];

        switch (key) {
            case 'qps':
            case 'messagesPerSecond':
                config.messagesPerSecond = parseInt(value || '30', 10);
                break;
            case 'duration':
            case 'hours':
                config.durationHours = parseFloat(value || '3');
                break;
            case 'users':
            case 'concurrentUsers':
                config.concurrentUsers = parseInt(value || '10', 10);
                break;
            case 'url':
            case 'baseUrl':
                config.baseUrl = value || 'http://127.0.0.1:8080';
                break;
            case 'streaming':
                config.enableStreaming = value === 'true';
                break;
            case 'proactive':
                config.enableProactive = value === 'true';
                break;
        }
    }

    const test = new LiveStressTest(config);

    try {
        const results = await test.run();
        test.printReport(results);

        // 保存报告到文件
        const reportPath = `./reports/stress-test-${Date.now()}.json`;
        const fs = require('fs');
        const path = require('path');
        const reportDir = path.dirname(reportPath);
        if (!fs.existsSync(reportDir)) {
            fs.mkdirSync(reportDir, { recursive: true });
        }
        fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf-8');
        console.log(`📄 报告已保存到: ${reportPath}`);
    } catch (error: any) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
}

// 如果直接运行此脚本
if (require.main === module) {
    main().catch(console.error);
}

export { LiveStressTest, StressTestConfig, TestResults };
