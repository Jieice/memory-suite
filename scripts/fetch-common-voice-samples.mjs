/**
 * 从 Hugging Face 获取 Common Voice 中文语音样本
 * 用于预览和筛选适合 GPT-SoVITS 训练的声音
 * 
 * 运行方式: 在项目根目录的 cmd 中执行
 *   cd manager && npm start
 *   然后访问 http://localhost:8080/api/fetch-voice-samples
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Hugging Face Datasets Server API
const HF_API_URL = 'https://datasets-server.huggingface.co';
const DATASET = 'mozilla-foundation/common_voice_17_0';
const LANGUAGE = 'zh-CN';

// 输出目录
const OUTPUT_DIR = path.resolve(__dirname, '../python/tts/sovits/common-voice-samples');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { 
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 30000 
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function downloadFile(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    
    function doDownload(downloadUrl) {
      https.get(downloadUrl, { 
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 60000 
      }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          doDownload(res.headers.location);
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(filepath, () => {});
        reject(err);
      });
    }
    
    doDownload(url);
  });
}

async function main() {
  console.log('🎤 Common Voice 中文样本获取工具');
  console.log('=' .repeat(40));
  console.log();

  // 创建输出目录
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  try {
    // 获取样本数据
    console.log('📥 获取样本数据...');
    const rowsUrl = `${HF_API_URL}/rows?dataset=${DATASET}&config=${LANGUAGE}&split=train&offset=0&length=20`;
    console.log(`   URL: ${rowsUrl}`);
    
    const data = await fetchJson(rowsUrl);
    
    if (data.error) {
      console.log(`\n⚠️  API 错误: ${data.error}`);
      showAlternative();
      return;
    }

    const rows = data.rows || [];
    console.log(`   获取到 ${rows.length} 个样本\n`);

    if (!rows.length) {
      console.log('没有获取到样本数据');
      showAlternative();
      return;
    }

    // 显示样本信息并下载
    const metadata = [];
    
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const sample = rows[i].row || {};
      const sentence = sample.sentence || '';
      const clientId = (sample.client_id || 'unknown').slice(0, 8);
      const gender = sample.gender || '未知';
      const age = sample.age || '未知';
      
      console.log(`[${i + 1}] ${sentence}`);
      console.log(`    说话人: ${clientId}...`);
      console.log(`    性别: ${gender}, 年龄: ${age}`);
      
      // 获取音频 URL
      const audioInfo = sample.audio || {};
      const audioUrl = typeof audioInfo === 'object' ? audioInfo.src : null;
      
      if (audioUrl) {
        const filename = `sample_${i + 1}.mp3`;
        const filepath = path.join(OUTPUT_DIR, filename);
        console.log(`    下载中...`);
        
        try {
          await downloadFile(audioUrl, filepath);
          const stats = fs.statSync(filepath);
          console.log(`    ✅ 已保存: ${filename} (${stats.size} bytes)`);
          
          metadata.push({
            id: i + 1,
            filename,
            text: sentence,
            gender,
            age,
            client_id: clientId
          });
        } catch (e) {
          console.log(`    ❌ 下载失败: ${e.message}`);
        }
      } else {
        console.log(`    ⚠️  无音频 URL`);
      }
      
      console.log();
    }

    // 保存元数据
    if (metadata.length) {
      const metaPath = path.join(OUTPUT_DIR, 'metadata.json');
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
      console.log(`📝 元数据已保存: ${metaPath}`);
    }
    
    console.log(`\n✅ 完成！`);
    console.log(`   样本目录: ${OUTPUT_DIR}`);
    console.log(`\n💡 提示: 听一下这些样本，选择音质好的用于 GPT-SoVITS 训练`);

  } catch (err) {
    console.error('❌ 错误:', err.message);
    showAlternative();
  }
}

function showAlternative() {
  console.log('\n' + '=' .repeat(40));
  console.log('🔄 备用方案');
  console.log('=' .repeat(40));
  console.log();
  console.log('方法 1: 使用 datasets 库 (推荐)');
  console.log();
  console.log('  pip install datasets soundfile');
  console.log('  python -c "');
  console.log('from datasets import load_dataset');
  console.log("ds = load_dataset('mozilla-foundation/common_voice_17_0', 'zh-CN', split='train[:10]', trust_remote_code=True)");
  console.log('for i, sample in enumerate(ds):');
  console.log('    print(f\\'{i}: {sample[\"sentence\"]}\\')"');
  console.log();
  console.log('方法 2: 手动下载');
  console.log();
  console.log('  1. 访问: https://commonvoice.mozilla.org/zh-CN/datasets');
  console.log('  2. 注册/登录 Mozilla 账号');
  console.log('  3. 下载 Common Voice Corpus (中文)');
  console.log();
}

main().catch(console.error);
