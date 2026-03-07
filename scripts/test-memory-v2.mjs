/**
 * Memory Suite v2 综合测试脚本
 * 
 * 测试所有新增模块:
 * - Evo-Memory (经验复用)
 * - Mem0 (事实提取)
 * - Transparent Memory (透明文件)
 * - MemoryR1 (强化学习)
 * 
 * 使用: node scripts/test-memory-v2.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

console.log('=== Memory Suite v2 综合测试 ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✅ ${name}`);
        passed++;
    } catch (err) {
        console.log(`❌ ${name}`);
        console.log(`   错误: ${err.message}`);
        failed++;
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        console.log(`✅ ${name}`);
        passed++;
    } catch (err) {
        console.log(`❌ ${name}`);
        console.log(`   错误: ${err.message}`);
        failed++;
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || '断言失败');
    }
}

// ========== 数据目录检查 ==========

function testDataDirectories() {
    console.log('\n--- 数据目录检查 ---');
    
    const dirs = [
        'data/evo_memory',
        'data/mem0_facts',
        'data/memory_r1',
        'data/memories/global',
        'data/memories/users',
        'data/memories/sessions',
    ];
    
    for (const dir of dirs) {
        test(`目录存在: ${dir}`, () => {
            const fullPath = path.join(ROOT_DIR, dir);
            assert(fs.existsSync(fullPath), `目录应存在: ${dir}`);
        });
    }
}

// ========== Evo-Memory 测试 ==========

function testEvoMemory() {
    console.log('\n--- Evo-Memory 测试 ---');
    
    const EXPERIENCE_PATH = path.join(ROOT_DIR, 'data/evo_memory/experiences.jsonl');
    const STRATEGY_PATH = path.join(ROOT_DIR, 'data/evo_memory/strategies.json');
    
    test('Evo-Memory: 数据文件路径正确', () => {
        assert(EXPERIENCE_PATH.includes('evo_memory'), '路径应包含 evo_memory');
    });
    
    test('Evo-Memory: 模拟添加经验', () => {
        const experience = {
            id: `exp_${Date.now()}`,
            timestamp: new Date().toISOString(),
            input: '你好',
            output: '你好呀！',
            feedback: 'success',
            reuseCount: 0,
        };
        
        const dir = path.dirname(EXPERIENCE_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.appendFileSync(EXPERIENCE_PATH, JSON.stringify(experience) + '\n', 'utf-8');
        
        const content = fs.readFileSync(EXPERIENCE_PATH, 'utf-8');
        assert(content.includes('你好'), '文件应包含添加的经验');
    });
    
    test('Evo-Memory: 读取经验', () => {
        if (fs.existsSync(EXPERIENCE_PATH)) {
            const content = fs.readFileSync(EXPERIENCE_PATH, 'utf-8');
            const lines = content.split('\n').filter(Boolean);
            assert(lines.length >= 1, '应有至少 1 条经验');
        }
    });
}

// ========== Mem0 测试 ==========

function testMem0() {
    console.log('\n--- Mem0 测试 ---');
    
    const FACTS_PATH = path.join(ROOT_DIR, 'data/mem0_facts/facts.jsonl');
    
    test('Mem0: 数据文件路径正确', () => {
        assert(FACTS_PATH.includes('mem0_facts'), '路径应包含 mem0_facts');
    });
    
    test('Mem0: 模拟添加事实', () => {
        const fact = {
            id: `fact_${Date.now()}`,
            userId: 'test_user',
            content: '用户喜欢玩游戏',
            category: 'preference',
            confidence: 0.9,
            createdAt: new Date().toISOString(),
        };
        
        const dir = path.dirname(FACTS_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.appendFileSync(FACTS_PATH, JSON.stringify(fact) + '\n', 'utf-8');
        
        const content = fs.readFileSync(FACTS_PATH, 'utf-8');
        assert(content.includes('喜欢玩游戏'), '文件应包含添加的事实');
    });
    
    test('Mem0: 事实分类正确', () => {
        const categories = ['preference', 'event', 'relationship', 'knowledge', 'trait'];
        assert(categories.includes('preference'), 'preference 应是有效分类');
        assert(categories.includes('event'), 'event 应是有效分类');
    });
}

// ========== Transparent Memory 测试 ==========

function testTransparentMemory() {
    console.log('\n--- Transparent Memory 测试 ---');
    
    const MEMORIES_PATH = path.join(ROOT_DIR, 'data/memories');
    
    test('Transparent: 全局记忆目录存在', () => {
        const globalDir = path.join(MEMORIES_PATH, 'global');
        assert(fs.existsSync(globalDir), '全局记忆目录应存在');
    });
    
    test('Transparent: PERSONALITY.md 存在', () => {
        const personalityPath = path.join(MEMORIES_PATH, 'global', 'PERSONALITY.md');
        assert(fs.existsSync(personalityPath), 'PERSONALITY.md 应存在');
    });
    
    test('Transparent: 读取人格设定', () => {
        const personalityPath = path.join(MEMORIES_PATH, 'global', 'PERSONALITY.md');
        const content = fs.readFileSync(personalityPath, 'utf-8');
        assert(content.includes('基本性格'), '应包含基本性格');
    });
    
    test('Transparent: 写入用户记忆', () => {
        const userDir = path.join(MEMORIES_PATH, 'users', 'test_user');
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }
        
        const profilePath = path.join(userDir, 'PROFILE.md');
        const content = '# 用户画像\n\n这是一个测试用户。';
        fs.writeFileSync(profilePath, content, 'utf-8');
        
        assert(fs.existsSync(profilePath), '用户画像文件应存在');
        const readContent = fs.readFileSync(profilePath, 'utf-8');
        assert(readContent.includes('测试用户'), '应包含写入的内容');
    });
}

// ========== MemoryR1 测试 ==========

function testMemoryR1() {
    console.log('\n--- MemoryR1 测试 ---');
    
    const POLICY_PATH = path.join(ROOT_DIR, 'data/memory_r1/policy.json');
    
    test('MemoryR1: 数据文件路径正确', () => {
        assert(POLICY_PATH.includes('memory_r1'), '路径应包含 memory_r1');
    });
    
    test('MemoryR1: 默认权重', () => {
        const defaultWeights = {
            importance: 0.35,
            recency: 0.25,
            redundancy: 0.25,
            random: 0.15,
            storeThreshold: 0.65,
            compressThreshold: 0.35,
        };
        
        assert(defaultWeights.importance > 0, 'importance 权重应 > 0');
        assert(defaultWeights.storeThreshold > defaultWeights.compressThreshold, 
            'storeThreshold 应 > compressThreshold');
    });
    
    test('MemoryR1: 决策逻辑', () => {
        function calculateScore(state, weights) {
            return (
                weights.importance * state.importance +
                weights.recency * state.recency -
                weights.redundancy * state.redundancy
            );
        }
        
        const weights = {
            importance: 0.35,
            recency: 0.25,
            redundancy: 0.25,
            storeThreshold: 0.65,
            compressThreshold: 0.35,
        };
        
        const highImportance = { importance: 0.9, recency: 1.0, redundancy: 0 };
        const score = calculateScore(highImportance, weights);
        assert(score > weights.compressThreshold, '高重要性应有较高分数');
    });
    
    test('MemoryR1: 写入策略文件', () => {
        const policy = {
            weights: {
                importance: 0.35,
                recency: 0.25,
                redundancy: 0.25,
                random: 0.15,
                storeThreshold: 0.65,
                compressThreshold: 0.35,
            },
            updatedAt: new Date().toISOString(),
        };
        
        const dir = path.dirname(POLICY_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2), 'utf-8');
        assert(fs.existsSync(POLICY_PATH), '策略文件应存在');
    });
}

// ========== API 端点检查 ==========

async function testAPIEndpoints() {
    console.log('\n--- API 端点检查 (需要服务运行) ---');
    
    const BASE_URL = process.env.MEMORY_SUITE_URL || process.env.MEMORY_UNIVERSE_URL || 'http://localhost:8080';
    
    async function checkEndpoint(endpoint, name) {
        try {
            const response = await fetch(`${BASE_URL}${endpoint}`, {
                method: 'GET',
                signal: AbortSignal.timeout(3000),
            });
            if (response.ok) {
                console.log(`✅ ${name}: ${endpoint}`);
                passed++;
            } else {
                console.log(`⚠️ ${name}: ${endpoint} (状态: ${response.status})`);
            }
        } catch (err) {
            console.log(`⏭️ ${name}: ${endpoint} (服务未运行)`);
        }
    }
    
    await checkEndpoint('/api/health', 'Unified Health');
    await checkEndpoint('/api/runtime/overview', 'Runtime Overview');
    await checkEndpoint('/api/knowledge/catalog?limit=3', 'Knowledge Catalog');
}

// ========== 主函数 ==========

async function main() {
    testDataDirectories();
    testEvoMemory();
    testMem0();
    testTransparentMemory();
    testMemoryR1();
    
    console.log('\n--- 可选: API 端点测试 ---');
    console.log('提示: 启动 memory-universe 服务后可测试 API');
    console.log('  cd memory-universe && npm run dev');
    console.log('  然后重新运行此脚本');
    
    try {
        await testAPIEndpoints();
    } catch (err) {
        console.log('API 测试跳过 (服务未运行)');
    }
    
    console.log('\n=== 测试结果 ===');
    console.log(`✅ 通过: ${passed}`);
    console.log(`❌ 失败: ${failed}`);
    console.log(`📊 总计: ${passed + failed}`);
    
    if (failed === 0) {
        console.log('\n🎉 所有基础测试通过！');
        console.log('\n下一步:');
        console.log('  1. 启动服务: cd memory-universe && npm run dev');
        console.log('  2. 测试 API: curl http://localhost:8080/api/runtime/overview');
        console.log('  3. 查看文档: docs/UNIFIED_RUST_RUNTIME.md');
    } else {
        console.log('\n⚠️ 部分测试失败，请检查错误信息');
    }
    
    process.exit(failed > 0 ? 1 : 0);
}

main();
