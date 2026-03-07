"""
使用 Edge TTS 生成 GPT-SoVITS 训练数据
声音: zh-CN-XiaohanNeural (晓涵 - 清新自然)

运行前先安装: pip install edge-tts
"""

import asyncio
import edge_tts
import os
import json

# 配置
VOICE = "zh-CN-XiaoyiNeural"  # 小艺 - 活泼年轻
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "python", "tts", "sovits", "training_audio")
RATE = "+0%"  # 语速，可调整 -50% ~ +50%
VOLUME = "+0%"  # 音量

# 训练文本 - 覆盖各种语气和场景
TRAINING_TEXTS = [
    # 日常对话
    "大家好，欢迎来到直播间，今天我们来聊点有趣的话题吧。",
    "哇，这个问题问得好，让我想想怎么回答。",
    "谢谢你的关注，真的很开心能认识你们。",
    "嗯，我觉得这个想法挺有意思的，你们觉得呢？",
    "哈哈，你说得太对了，我也是这么想的。",
    
    # 情感表达
    "真的吗？太棒了，我好开心啊！",
    "唉，这件事确实让人有点难过呢。",
    "哎呀，不好意思，我刚才说错了。",
    "好期待啊，感觉会很有趣的样子。",
    "谢谢大家的支持，我会继续努力的。",
    
    # 互动回应
    "欢迎新来的朋友，记得点个关注哦。",
    "这位朋友说得很有道理，我赞同。",
    "等一下，让我看看弹幕说了什么。",
    "好的好的，我知道了，马上就来。",
    "你们想听什么？可以在弹幕里告诉我。",
    
    # 知识分享
    "其实这个问题很简单，让我来解释一下。",
    "根据我的了解，这件事情是这样的。",
    "有一个小技巧想分享给大家。",
    "这个知识点很重要，大家要记住哦。",
    "让我给你们举个例子，这样更容易理解。",
    
    # 语气词和短句
    "嗯嗯，是的。",
    "好的，没问题。",
    "哦，原来是这样啊。",
    "真的假的？",
    "太厉害了吧！",
    "不会吧，这也太巧了。",
    "等等，我想想。",
    "对对对，就是这个意思。",
    
    # 长句练习
    "今天的天气真不错，阳光明媚的，让人心情都变好了呢。",
    "我最近在学习一些新东西，虽然有点难，但是很有成就感。",
    "说到这个话题，我突然想起来一件有趣的事情想跟大家分享。",
    "其实我一开始也不太懂，后来慢慢研究才明白是怎么回事。",
    "希望大家都能找到自己喜欢的事情，然后坚持下去。",
    
    # 数字和特殊内容
    "现在是晚上八点整，直播正式开始。",
    "这个活动从一月一号持续到三月三十一号。",
    "我们已经有一万两千三百四十五位粉丝了。",
    "百分之八十的人都选择了第一个选项。",
    
    # 英文混合
    "这个功能叫做 AI 语音合成，英文是 Text to Speech。",
    "我们用的是 Python 编程语言来实现的。",
    "这个项目在 GitHub 上是开源的。",
]

async def generate_audio(text: str, index: int) -> dict:
    """生成单条音频"""
    filename = f"xiaohan_{index:03d}.wav"
    filepath = os.path.join(OUTPUT_DIR, filename)
    
    communicate = edge_tts.Communicate(text, VOICE, rate=RATE, volume=VOLUME)
    await communicate.save(filepath)
    
    print(f"[{index:03d}] {text[:30]}{'...' if len(text) > 30 else ''}")
    
    return {
        "audio_path": filename,
        "text": text,
        "speaker": "xiaohan"
    }

async def main():
    print("=" * 50)
    print("Edge TTS 训练数据生成器")
    print(f"声音: {VOICE} (晓涵)")
    print(f"输出目录: {OUTPUT_DIR}")
    print("=" * 50)
    print()
    
    # 创建输出目录
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # 生成音频
    metadata = []
    for i, text in enumerate(TRAINING_TEXTS, 1):
        try:
            info = await generate_audio(text, i)
            metadata.append(info)
        except Exception as e:
            print(f"[{i:03d}] 错误: {e}")
    
    # 保存元数据
    meta_path = os.path.join(OUTPUT_DIR, "metadata.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)
    
    # 生成 GPT-SoVITS 格式的标注文件
    list_path = os.path.join(OUTPUT_DIR, "xiaohan.list")
    with open(list_path, "w", encoding="utf-8") as f:
        for item in metadata:
            # 格式: 音频路径|说话人|语言|文本
            f.write(f"{item['audio_path']}|xiaohan|zh|{item['text']}\n")
    
    print()
    print("=" * 50)
    print(f"✅ 完成！共生成 {len(metadata)} 条音频")
    print(f"📁 音频目录: {OUTPUT_DIR}")
    print(f"📝 标注文件: {list_path}")
    print()
    print("下一步:")
    print("1. 下载 GPT-SoVITS: https://github.com/RVC-Boss/GPT-SoVITS/releases")
    print("2. 解压到 python/tts/sovits/ 目录")
    print("3. 用 WebUI 训练模型")
    print("=" * 50)

if __name__ == "__main__":
    asyncio.run(main())
