import unittest

from edge_tts_server import choose_voice_from_names


class ChooseVoiceFromNamesTests(unittest.TestCase):
    def test_maps_edge_tts_zh_alias_to_available_chinese_voice(self):
        resolved = choose_voice_from_names(
            "edge-tts-zh",
            ["zh-CN-XiaoxiaoNeural", "en-US-AvaNeural"],
        )
        self.assertEqual(resolved, "zh-CN-XiaoxiaoNeural")

    def test_keeps_exact_voice_when_available(self):
        resolved = choose_voice_from_names(
            "en-US-AvaNeural",
            ["zh-CN-XiaoxiaoNeural", "en-US-AvaNeural"],
        )
        self.assertEqual(resolved, "en-US-AvaNeural")

    def test_uses_chinese_default_when_voice_is_missing(self):
        resolved = choose_voice_from_names(
            None,
            ["zh-CN-YunxiNeural", "en-US-AvaNeural"],
        )
        self.assertEqual(resolved, "zh-CN-YunxiNeural")


if __name__ == "__main__":
    unittest.main()
