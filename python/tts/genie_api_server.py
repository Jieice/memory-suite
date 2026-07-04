import argparse
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# 配置
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 9880
DEFAULT_GUI_DIR = os.path.join(SCRIPT_DIR, "Genie-TTS GUI")
CHARACTER_NAME = "feibi"


def build_character(gui_dir):
    character_models_dir = os.path.join(gui_dir, "CharacterModels")
    character = {
        "model_dir": os.path.join(character_models_dir, "v2ProPlus", "feibi", "tts_models"),
        "language": "zh",
        "name": "菲比 (中文)",
    }
    return character, character_models_dir


def build_reference_audios():
    references_dir = os.path.join(SCRIPT_DIR, "reference")
    return {
        "neutral": {
            "path": os.path.join(references_dir, "ref.wav"),
            "text": "你好，欢迎来到直播间。",
        },
        "happy": {
            "path": os.path.join(references_dir, "ref.wav"),
            "text": "今天有什么有趣的事情吗？",
        },
        "angry": {
            "path": os.path.join(references_dir, "ref.wav"),
            "text": "我真的很生气！",
        },
        "sad": {
            "path": os.path.join(references_dir, "ref.wav"),
            "text": "今天发生了很多事情，我很难过。",
        },
    }

def parse_args():
    parser = argparse.ArgumentParser(description="Run the Genie TTS adapter server.")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--gui-dir", default=DEFAULT_GUI_DIR)
    parser.add_argument("--genie-data-dir")
    return parser.parse_args()


def main():
    args = parse_args()
    gui_dir = args.gui_dir
    genie_data_dir = args.genie_data_dir or os.path.join(gui_dir, "GenieData")
    character, character_models_dir = build_character(gui_dir)
    reference_audios = build_reference_audios()

    os.environ["GENIE_DATA_DIR"] = genie_data_dir

    import genie_tts as genie

    print(f"[Genie-TTS] 数据目录: {genie_data_dir}")
    print(f"[Genie-TTS] 角色模型目录: {character_models_dir}")
    print()

    # 加载角色
    print(f"[加载角色] {character['name']}...")
    try:
        genie.load_character(
            character_name=CHARACTER_NAME,
            onnx_model_dir=character["model_dir"],
            language=character["language"],
        )
        print(f"  ✓ 角色 '{CHARACTER_NAME}' 加载成功")
    except Exception as e:
        print(f"  ✗ 加载失败: {e}")
        return

    # 设置默认参考音频 (neutral)
    print()
    print("[设置参考音频]")
    default_ref = reference_audios["neutral"]
    if os.path.exists(default_ref["path"]):
        print(f"  使用: {default_ref['path']}")
        try:
            genie.set_reference_audio(
                character_name=CHARACTER_NAME,
                audio_path=default_ref["path"],
                audio_text=default_ref["text"],
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
