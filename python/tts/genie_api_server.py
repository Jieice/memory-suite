import argparse
import os

# 设置GenieData路径 - 使用相对路径或默认GUI目录
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
GUI_DIR = os.environ.get('GENIE_GUI_DIR', os.path.join(SCRIPT_DIR, 'Genie-TTS GUI'))
GENIE_DATA_DIR = os.environ.get('GENIE_DATA_DIR', os.path.join(GUI_DIR, "GenieData"))
CHARACTER_MODELS_DIR = os.path.join(GUI_DIR, "CharacterModels")

os.environ["GENIE_DATA_DIR"] = GENIE_DATA_DIR

import genie_tts as genie

# 配置
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 9880
CHARACTER_NAME = "feibi"
LANGUAGE = "zh"

# 角色配置
CHARACTER = {
    "model_dir": os.path.join(CHARACTER_MODELS_DIR, "v2ProPlus", "feibi", "tts_models"),
    "language": "zh",
    "name": "菲比 (中文)"
}

# 参考音频配置 - 使用微软语音转换的WAV
REFERENCES_DIR = os.path.join(SCRIPT_DIR, "reference")

REFERENCE_AUDIOS = {
    "neutral": {
        "path": os.path.join(REFERENCES_DIR, "ref.wav"),
        "text": "你好，欢迎来到直播间。"
    },
    "happy": {
        "path": os.path.join(REFERENCES_DIR, "ref.wav"),
        "text": "今天有什么有趣的事情吗？"
    },
    "angry": {
        "path": os.path.join(REFERENCES_DIR, "ref.wav"),
        "text": "我真的很生气！"
    },
    "sad": {
        "path": os.path.join(REFERENCES_DIR, "ref.wav"),
        "text": "今天发生了很多事情，我很难过。"
    }
}

def parse_args():
    parser = argparse.ArgumentParser(description="Run the Genie TTS adapter server.")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    return parser.parse_args()


def main():
    args = parse_args()
    print(f"[Genie-TTS] 数据目录: {GENIE_DATA_DIR}")
    print(f"[Genie-TTS] 角色模型目录: {CHARACTER_MODELS_DIR}")
    print()

    # 加载角色
    print(f"[加载角色] {CHARACTER['name']}...")
    try:
        genie.load_character(
            character_name=CHARACTER_NAME,
            onnx_model_dir=CHARACTER["model_dir"],
            language=CHARACTER["language"]
        )
        print(f"  ✓ 角色 '{CHARACTER_NAME}' 加载成功")
    except Exception as e:
        print(f"  ✗ 加载失败: {e}")
        return

    # 设置默认参考音频 (neutral)
    print()
    print("[设置参考音频]")
    default_ref = REFERENCE_AUDIOS["neutral"]
    if os.path.exists(default_ref["path"]):
        print(f"  使用: {default_ref['path']}")
        try:
            genie.set_reference_audio(
                character_name=CHARACTER_NAME,
                audio_path=default_ref["path"],
                audio_text=default_ref["text"]
            )
            print(f"  ✓ 参考音频设置成功")
        except Exception as e:
            print(f"  ✗ 设置失败: {e}")
    else:
        print(f"  ✗ 参考音频不存在: {default_ref['path']}")

    print()
    print(f"[Genie-TTS] 启动API服务器: http://{args.host}:{args.port}")
    print("[提示] API端点:")
    print("  POST /tts - 合成语音 (参数: character_name, text)")
    print("\n按 Ctrl+C 停止服务\n")

    genie.start_server(host=args.host, port=args.port, workers=1)

if __name__ == "__main__":
    main()
