"""
从 Hugging Face 获取 Common Voice 中文语音样本
用于预览和筛选适合 GPT-SoVITS 训练的声音
"""

import os
import json
import urllib.request
import ssl

# 忽略 SSL 证书验证（某些环境需要）
ssl._create_default_https_context = ssl._create_unverified_context

# Hugging Face Datasets Server API
HF_API_URL = "https://datasets-server.huggingface.co"
DATASET = "mozilla-foundation/common_voice_17_0"
LANGUAGE = "zh-CN"

# 输出目录
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "..", "python", "tts", "sovits", "common-voice-samples")

def fetch_json(url):
    """获取 JSON 数据"""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode())

def download_file(url, filepath):
    """下载文件"""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        with open(filepath, 'wb') as f:
            f.write(response.read())

def main():
    print("🎤 Common Voice 中文样本获取工具")
    print("=" * 40)
    print()

    # 创建输出目录
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    try:
        # 1. 获取样本数据
        print("📥 获取样本数据...")
        rows_url = f"{HF_API_URL}/rows?dataset={DATASET}&config={LANGUAGE}&split=train&offset=0&length=20"
        print(f"   URL: {rows_url}")
        
        data = fetch_json(rows_url)
        
        if "error" in data:
            print(f"\n⚠️  API 错误: {data['error']}")
            show_alternative()
            return

        rows = data.get("rows", [])
        print(f"   获取到 {len(rows)} 个样本\n")

        if not rows:
            print("没有获取到样本数据")
            show_alternative()
            return

        # 2. 显示样本信息并下载
        metadata = []
        
        for i, item in enumerate(rows[:10]):
            sample = item.get("row", {})
            sentence = sample.get("sentence", "")
            client_id = sample.get("client_id", "unknown")[:8]
            gender = sample.get("gender", "未知")
            age = sample.get("age", "未知")
            
            print(f"[{i + 1}] {sentence}")
            print(f"    说话人: {client_id}...")
            print(f"    性别: {gender}, 年龄: {age}")
            
            # 获取音频 URL
            audio_info = sample.get("audio", {})
            audio_url = audio_info.get("src") if isinstance(audio_info, dict) else None
            
            if audio_url:
                filename = f"sample_{i + 1}.mp3"
                filepath = os.path.join(OUTPUT_DIR, filename)
                print(f"    下载中...")
                
                try:
                    download_file(audio_url, filepath)
                    file_size = os.path.getsize(filepath)
                    print(f"    ✅ 已保存: {filename} ({file_size} bytes)")
                    
                    metadata.append({
                        "id": i + 1,
                        "filename": filename,
                        "text": sentence,
                        "gender": gender,
                        "age": age,
                        "client_id": client_id
                    })
                except Exception as e:
                    print(f"    ❌ 下载失败: {e}")
            else:
                print(f"    ⚠️  无音频 URL")
            
            print()

        # 3. 保存元数据
        if metadata:
            meta_path = os.path.join(OUTPUT_DIR, "metadata.json")
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(metadata, f, ensure_ascii=False, indent=2)
            print(f"📝 元数据已保存: {meta_path}")
        
        print(f"\n✅ 完成！")
        print(f"   样本目录: {OUTPUT_DIR}")
        print(f"\n💡 提示: 听一下这些样本，选择音质好的用于 GPT-SoVITS 训练")

    except Exception as e:
        print(f"❌ 错误: {e}")
        show_alternative()

def show_alternative():
    print("\n" + "=" * 40)
    print("🔄 备用方案")
    print("=" * 40)
    print()
    print("方法 1: 使用 datasets 库 (推荐)")
    print()
    print("  pip install datasets soundfile")
    print("  python -c \"")
    print("from datasets import load_dataset")
    print("ds = load_dataset('mozilla-foundation/common_voice_17_0', 'zh-CN', split='train[:10]', trust_remote_code=True)")
    print("for i, sample in enumerate(ds):")
    print("    print(f'{i}: {sample[\"sentence\"]}')")
    print("\"")
    print()
    print("方法 2: 手动下载")
    print()
    print("  1. 访问: https://commonvoice.mozilla.org/zh-CN/datasets")
    print("  2. 注册/登录 Mozilla 账号")
    print("  3. 下载 Common Voice Corpus (中文)")
    print()

if __name__ == "__main__":
    main()
