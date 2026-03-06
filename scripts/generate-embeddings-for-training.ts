/**
 * 为训练样本生成真实嵌入向量
 * 
 * 从 50 万 LCCC 样本中随机抽取 1 万条，调用嵌入 API 生成真实嵌入
 * 预计耗时：约 30 分钟
 */

import * as fs from 'fs';
import * as path from 'path';

// 配置
const CONFIG = {
  SAMPLES_PATH: path.join(__dirname, '..', 'data', 'training', 'samples.json'),
  OUTPUT_PATH: path.join(__dirname, '..', 'data', 'training', 'samples-with-embeddings.json'),
  
  // 嵌入 API
  EMBEDDING_API_URL: process.env.EMBEDDING_API_URL || 'https://api.siliconflow.cn/v1/embeddings',
  EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY || '',
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'BAAI/bge-m3',
  EMBEDDING_DIM: parseInt(process.env.EMBEDDING_DIM || '1024'),
  
  // 采样配置
  SAMPLE_COUNT: 10000,  // 抽取 1 万条
  BATCH_SIZE: 20,       // 每批 20 条（API 限制）
  DELAY_MS: 200,        // 每批间隔 200ms，避免限流
  
  // 进度保存
  CHECKPOINT_INTERVAL: 500,  // 每 500 条保存一次进度
};

interface TrainingSample {
  id: string;
  features: {
    stateVector: number[];
    perceptionVector: number[];
    messageEmbedding: number[];
    memoryContextEmbedding: number[];
  };
  label: {
    selectedCandidate: string;
    wasRejected?: boolean;
    userFeedback?: string;
  };
  metadata?: {
    inputText?: string;
    outputText?: string;
    quality?: number;
    source?: string;
  };
}

// 加载 .env
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

// 调用嵌入 API
async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.EMBEDDING_API_KEY || CONFIG.EMBEDDING_API_KEY;
  const apiUrl = process.env.EMBEDDING_API_URL || CONFIG.EMBEDDING_API_URL;
  const model = process.env.EMBEDDING_MODEL || CONFIG.EMBEDDING_MODEL;
  
  if (!apiKey) {
    throw new Error('EMBEDDING_API_KEY not set');
  }
  
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: texts,
      encoding_format: 'float'
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Embedding API error: ${response.status} - ${error}`);
  }
  
  const data = await response.json() as any;
  return data.data.map((item: any) => item.embedding);
}

// 随机打乱数组
function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// 延迟
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 保存检查点
function saveCheckpoint(samples: TrainingSample[], processedCount: number) {
  const checkpointPath = CONFIG.OUTPUT_PATH + '.checkpoint';
  fs.writeFileSync(checkpointPath, JSON.stringify({
    processedCount,
    samples: samples.slice(0, processedCount)
  }));
  console.log(`💾 检查点已保存: ${processedCount} 条`);
}

// 加载检查点
function loadCheckpoint(): { processedCount: number; samples: TrainingSample[] } | null {
  const checkpointPath = CONFIG.OUTPUT_PATH + '.checkpoint';
  if (fs.existsSync(checkpointPath)) {
    const data = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
    return data;
  }
  return null;
}

async function main() {
  console.log('🚀 开始生成训练样本嵌入向量\n');
  
  // 加载环境变量
  loadEnv();
  
  // 检查 API Key
  if (!process.env.EMBEDDING_API_KEY) {
    console.error('❌ 错误: EMBEDDING_API_KEY 未设置');
    process.exit(1);
  }
  
  console.log(`📊 配置:`);
  console.log(`   - 嵌入 API: ${process.env.EMBEDDING_API_URL}`);
  console.log(`   - 模型: ${process.env.EMBEDDING_MODEL}`);
  console.log(`   - 维度: ${process.env.EMBEDDING_DIM}`);
  console.log(`   - 目标样本数: ${CONFIG.SAMPLE_COUNT}`);
  console.log(`   - 批量大小: ${CONFIG.BATCH_SIZE}`);
  console.log('');
  
  // 读取原始样本
  console.log('📖 读取原始样本...');
  const rawData = fs.readFileSync(CONFIG.SAMPLES_PATH, 'utf-8');
  let allSamples: TrainingSample[];
  
  const parsed = JSON.parse(rawData);
  if (Array.isArray(parsed)) {
    allSamples = parsed;
  } else if (parsed.samples && Array.isArray(parsed.samples)) {
    allSamples = parsed.samples;
  } else {
    console.error('❌ 无法解析样本文件格式');
    process.exit(1);
  }
  
  console.log(`   总样本数: ${allSamples.length}`);
  
  // 过滤有效样本（有 inputText 和 outputText）
  const validSamples = allSamples.filter(s => 
    s.metadata?.inputText && 
    s.metadata?.outputText &&
    s.metadata.inputText.length > 0 &&
    s.metadata.outputText.length > 0
  );
  console.log(`   有效样本数: ${validSamples.length}`);
  
  // 随机抽取
  const shuffled = shuffle(validSamples);
  const selectedSamples = shuffled.slice(0, CONFIG.SAMPLE_COUNT);
  console.log(`   抽取样本数: ${selectedSamples.length}`);
  console.log('');
  
  // 检查是否有检查点
  const checkpoint = loadCheckpoint();
  let startIndex = 0;
  let processedSamples: TrainingSample[] = [...selectedSamples];
  
  if (checkpoint) {
    console.log(`📂 发现检查点，从 ${checkpoint.processedCount} 条继续...`);
    startIndex = checkpoint.processedCount;
    // 恢复已处理的样本
    for (let i = 0; i < checkpoint.processedCount && i < checkpoint.samples.length; i++) {
      processedSamples[i] = checkpoint.samples[i];
    }
  }
  
  // 开始生成嵌入
  const startTime = Date.now();
  let successCount = startIndex;
  let errorCount = 0;
  
  console.log('🔄 开始生成嵌入向量...\n');
  
  for (let i = startIndex; i < selectedSamples.length; i += CONFIG.BATCH_SIZE) {
    const batchEnd = Math.min(i + CONFIG.BATCH_SIZE, selectedSamples.length);
    const batch = selectedSamples.slice(i, batchEnd);
    
    // 准备文本
    const inputTexts = batch.map(s => s.metadata?.inputText || '');
    const outputTexts = batch.map(s => s.metadata?.outputText || '');
    
    try {
      // 获取输入嵌入
      const inputEmbeddings = await getEmbeddings(inputTexts);
      await delay(50);
      
      // 获取输出嵌入（作为 memoryContextEmbedding）
      const outputEmbeddings = await getEmbeddings(outputTexts);
      
      // 更新样本
      for (let j = 0; j < batch.length; j++) {
        const sampleIndex = i + j;
        processedSamples[sampleIndex] = {
          ...selectedSamples[sampleIndex],
          features: {
            ...selectedSamples[sampleIndex].features,
            messageEmbedding: inputEmbeddings[j],
            memoryContextEmbedding: outputEmbeddings[j]
          }
        };
      }
      
      successCount += batch.length;
      
      // 进度显示
      const progress = ((i + batch.length) / selectedSamples.length * 100).toFixed(1);
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = successCount / elapsed;
      const remaining = (selectedSamples.length - i - batch.length) / rate;
      
      process.stdout.write(`\r   进度: ${progress}% (${successCount}/${selectedSamples.length}) | 速度: ${rate.toFixed(1)}/s | 剩余: ${Math.ceil(remaining / 60)}分钟   `);
      
      // 保存检查点
      if (successCount % CONFIG.CHECKPOINT_INTERVAL === 0) {
        console.log('');
        saveCheckpoint(processedSamples, successCount);
      }
      
    } catch (error) {
      errorCount += batch.length;
      console.error(`\n❌ 批次 ${i}-${batchEnd} 失败:`, error);
      
      // 保存检查点后继续
      saveCheckpoint(processedSamples, successCount);
      
      // 等待后重试
      await delay(2000);
    }
    
    // 批次间延迟
    await delay(CONFIG.DELAY_MS);
  }
  
  console.log('\n');
  
  // 保存最终结果
  console.log('💾 保存最终结果...');
  
  const outputData = {
    metadata: {
      generatedAt: new Date().toISOString(),
      totalSamples: successCount,
      embeddingModel: process.env.EMBEDDING_MODEL,
      embeddingDim: parseInt(process.env.EMBEDDING_DIM || '1024'),
      source: 'LCCC + SiliconFlow Embeddings'
    },
    samples: processedSamples.slice(0, successCount)
  };
  
  fs.writeFileSync(CONFIG.OUTPUT_PATH, JSON.stringify(outputData));
  
  // 删除检查点
  const checkpointPath = CONFIG.OUTPUT_PATH + '.checkpoint';
  if (fs.existsSync(checkpointPath)) {
    fs.unlinkSync(checkpointPath);
  }
  
  // 统计
  const totalTime = (Date.now() - startTime) / 1000;
  console.log('\n✅ 完成！\n');
  console.log(`📊 统计:`);
  console.log(`   - 成功: ${successCount} 条`);
  console.log(`   - 失败: ${errorCount} 条`);
  console.log(`   - 耗时: ${Math.ceil(totalTime / 60)} 分钟`);
  console.log(`   - 输出: ${CONFIG.OUTPUT_PATH}`);
  console.log('');
  console.log('💡 下一步: 运行 npm run train 或在 Web 界面点击训练按钮');
}

main().catch(console.error);
