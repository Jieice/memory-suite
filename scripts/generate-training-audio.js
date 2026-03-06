/**
 * 使用 Edge TTS 生成 GPT-SoVITS 训练数据
 * 声音: zh-CN-XiaohanNeural (晓涵 - 清新自然)
 * 
 * 依赖: npm install edge-tts-node (或用 child_process 调用 edge-tts CLI)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 配置
const VOICE = "zh-CN-XiaohanNeural";  // 晓涵
const OUTPUT_DIR = path.resolve(__dirname, "../memory-tts/sovits/training_audio");
const RATE = "+0%";

// 训练文本
const TRAINING_TEXTS = [
    // 日常对话
    "大家好，欢迎来到直播间，今天我们来聊点有趣的话题吧。",
    "哇，这个问题问得好，让我想想怎么回答。",
    "谢谢你的关注，真的很开心能认识你们。",
    "嗯，我觉得这个想法挺有意思的，你们觉得呢？",
    "哈哈，你说得太对了，我也是这么想的。",
    
    // 情感表达
    "真的吗？太棒了，我好开心啊！",
    "唉，这件事确实让人有点难过呢。",
    "哎呀，不好意思，我刚才说错了。",
    "好期待啊，感觉会很有趣的样子。",
    "谢谢大家的支持，我会继续努力的。",
    
    // 互动回应
    "欢迎新来的朋友，记得点个关注哦。",
    "这位朋友说得很有道理，我赞同。",
    "等一下，让我看看弹幕说了什么。",
    "好的好的，我知道了，马上就来。",
    "你们想听什么？可以在弹幕里告诉我。",
    
    // 知识分享
    "其实这个问题很简单，让我来解释一下。",
    "根据我的了解，这件事情是这样的。",
    "有一个小技巧想分享给大家。",
    "这个知识点很重要，大家要记住哦。",
    "让我给你们举个例子，这样更容易理解。",
    
    // 语气词和短句
    "嗯嗯，是的。",
    "好的，没问题。",
    "哦，原来是这样啊。",
    "真的假的？",
    "太厉害了吧！",
    "不会吧，这也太巧了。",
    "等等，我想想。",
    "对对对，就是这个意思。",
    
    // 长句练习
    "今天的天气真不错，阳光明媚的，让人心情都变好了呢。",
    "我最近在学习一些新东西，虽然有点难，但是很有成就感。",
    "说到这个话题，我突然想起来一件有趣的事情想跟大家分享。",
    "其实我一开始也不太懂，后来慢慢研究才明白是怎么回事。",
    "希望大家都能找到自己喜欢的事情，然后坚持下去。",
    
    // 数字和特殊内容
    "现在是晚上八点整，直播正式开始。",
    "这个活动从一月一号持续到三月三十一号。",
    "我们已经有一万两千三百四十五位粉丝了。",
    "百分之八十的人都选择了第一个选项。",
    
    // 英文混合
    "这个功能叫做语音合成，英文是 Text to Speech。",
    "我们用的是 Python 编程语言来实现的。",
    "这个项目在 GitHub 上是开源的。",
];

// 确保输出目录存在
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

console.log("=".repeat(50));
console.log("Edge TTS 训练数据生成器");
console.log(`声音: ${VOICE} (晓涵)`);
console.log(`输出目录: ${OUTPUT_DIR}`);
console.log("=".repeat(50));
console.log();

// 检查 edge-tts 是否安装
function checkEdgeTTS() {
    return new Promise((resolve) => {
        const proc = spawn('pip', ['show', 'edge-tts'], { shell: true });
        proc.on('close', (code) => resolve(code === 0));
    });
}

// 安装 edge-tts
function installEdgeTTS() {
    return new Promise((resolve, reject) => {
        console.log("正在安装 edge-tts...");
        const proc = spawn('pip', ['install', 'edge-tts'], { 
            shell: true,
            stdio: 'inherit'
        });
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error('安装 edge-tts 失败'));
        });
    });
}

// 生成单条音频
function generateAudio(text, index) {
    return new Promise((resolve, reject) => {
        const filename = `xiaohan_${String(index).padStart(3, '0')}.wav`;
        const filepath = path.join(OUTPUT_DIR, filename);
        
        // 使用 edge-tts CLI
        const args = [
            '-m', 'edge_tts',
            '--voice', VOICE,
            '--rate', RATE,
            '--text', text,
            '--write-media', filepath
        ];
        
        const proc = spawn('python', args, { shell: true });
        
        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        
        proc.on('close', (code) => {
            if (code === 0) {
                const shortText = text.length > 30 ? text.slice(0, 30) + '...' : text;
                console.log(`[${String(index).padStart(3, '0')}] ${shortText}`);
                resolve({ audio_path: filename, text, speaker: 'xiaohan' });
            } else {
                reject(new Error(`生成失败: ${stderr}`));
            }
        });
    });
}

// 主函数
async function main() {
    // 检查并安装 edge-tts
    const hasEdgeTTS = await checkEdgeTTS();
    if (!hasEdgeTTS) {
        await installEdgeTTS();
    }
    
    console.log(`开始生成 ${TRAINING_TEXTS.length} 条音频...\n`);
    
    const metadata = [];
    
    for (let i = 0; i < TRAINING_TEXTS.length; i++) {
        try {
            const info = await generateAudio(TRAINING_TEXTS[i], i + 1);
            metadata.push(info);
        } catch (err) {
            console.error(`[${String(i + 1).padStart(3, '0')}] 错误: ${err.message}`);
        }
    }
    
    // 保存元数据
    const metaPath = path.join(OUTPUT_DIR, 'metadata.json');
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    
    // 生成 GPT-SoVITS 格式的标注文件
    const listPath = path.join(OUTPUT_DIR, 'xiaohan.list');
    const listContent = metadata.map(item => 
        `${item.audio_path}|xiaohan|zh|${item.text}`
    ).join('\n');
    fs.writeFileSync(listPath, listContent);
    
    console.log();
    console.log("=".repeat(50));
    console.log(`✅ 完成！共生成 ${metadata.length} 条音频`);
    console.log(`📁 音频目录: ${OUTPUT_DIR}`);
    console.log(`📝 标注文件: ${listPath}`);
    console.log();
    console.log("下一步:");
    console.log("1. 下载 GPT-SoVITS 整合包");
    console.log("2. 解压到 memory-tts/sovits/ 目录");
    console.log("3. 用 WebUI 训练模型");
    console.log("=".repeat(50));
}

main().catch(err => {
    console.error("错误:", err.message);
    process.exit(1);
});
