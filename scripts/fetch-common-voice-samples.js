/**
 * 从 Hugging Face 获取 Common Voice 中文语音样本
 * 用于预览和筛选适合 GPT-SoVITS 训练的声音
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Hugging Face API 配置
const HF_API_URL = 'https://datasets-server.huggingface.co';
const DATASET = 'mozilla-foundation/common_voice_17_0';
const LANGUAGE = 'zh-CN';  // 中文普通话

// 输出目录
const OUTPUT_DIR = path.resolve(__dirname, '../memory-tts/sovits/common-voice-samples');

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function downloadFile(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // 跟随重定向
        https.get(res.headers.location, (res2) => {
          res2.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        }).on('error', reject);
      } else {
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }
    }).on('error', reject);
  });
}

async function main() {
  console.log('🎤 Common Voice 中文样本获取工具');
  console.log('================================\n');

  // 创建输出目录
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  try {
    // 1. 获取数据集信息
    console.log('📊 获取数据集信息...');
    const infoUrl = `${HF_API_URL}/info?dataset=${DATASET}&config=${LANGUAGE}`;
    console.log(`   URL: ${infoUrl}`);
    
    const info = await fetchJson(infoUrl);
    console.log(`   数据集: ${DATASET}`);
    console.log(`   语言: ${LANGUAGE}`);
    
    if (info.error) {
      console.log(`\n⚠️  API 返回错误: ${info.error}`);
      console.log('\n尝试使用备用方法...');
      await fetchAlternative();
      return;
    }

    // 2. 获取样本数据
    console.log('\n📥 获取样本数据...');
    const rowsUrl = `${HF_API_URL}/rows?dataset=${DATASET}&config=${LANGUAGE}&split=train&offset=0&length=20`;
    const rows = await fetchJson(rowsUrl);
    
    if (rows.error) {
      console.log(`\n⚠️  获取样本失败: ${rows.error}`);
      await fetchAlternative();
      return;
    }

    console.log(`   获取到 ${rows.rows?.length || 0} 个样本\n`);

    // 3. 显示样本信息并下载
    const samples = rows.rows || [];
    const metadata = [];

    for (let i = 0; i < Math.min(samples.length, 10); i++) {
      const sample = samples[i].row;
      console.log(`[${i + 1}] ${sample.sentence}`);
      console.log(`    说话人: ${sample.client_id?.slice(0, 8) || 'unknown'}...`);
      console.log(`    性别: ${sample.gender || '未知'}, 年龄: ${sample.age || '未知'}`);
      
      // 下载音频
      if (sample.audio?.src) {
        const filename = `sample_${i + 1}.mp3`;
        const filepath = path.join(OUTPUT_DIR, filename);
        console.log(`    下载中...`);
        
        try {
          await downloadFile(sample.audio.src, filepath);
          console.log(`    ✅ 已保存: ${filename}`);
          
          metadata.push({
            id: i + 1,
            filename,
            text: sample.sentence,
            gender: sample.gender,
            age: sample.age,
            client_id: sample.client_id?.slice(0, 16)
          });
        } catch (e) {
          console.log(`    ❌ 下载失败: ${e.message}`);
        }
      }
      console.log('');
    }

    // 4. 保存元数据
    const metaPath = path.join(OUTPUT_DIR, 'metadata.json');
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    console.log(`\n📝 元数据已保存: ${metaPath}`);
    
    console.log('\n✅ 完成！');
    console.log(`   样本目录: ${OUTPUT_DIR}`);
    console.log('\n💡 提示: 听一下这些样本，选择音质好的用于 GPT-SoVITS 训练');

  } catch (err) {
    console.error('❌ 错误:', err.message);
    await fetchAlternative();
  }
}

async function fetchAlternative() {
  console.log('\n🔄 使用备用方案: 直接从 Common Voice 网站获取信息\n');
  console.log('由于 API 限制，请手动下载:');
  console.log('');
  console.log('1. 访问: https://commonvoice.mozilla.org/zh-CN/datasets');
  console.log('2. 注册/登录 Mozilla 账号');
  console.log('3. 下载 Common Voice Corpus (中文)');
  console.log('4. 解压后在 clips/ 目录找到音频文件');
  console.log('');
  console.log('或者使用 Hugging Face CLI:');
  console.log('');
  console.log('  pip install datasets');
  console.log('  python -c "from datasets import load_dataset; ds = load_dataset(\'mozilla-foundation/common_voice_17_0\', \'zh-CN\', split=\'train[:10]\'); print(ds)"');
  console.log('');
}

main();
