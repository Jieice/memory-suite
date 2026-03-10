import asyncio
import unittest

import edge_tts_server
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


class SynthesizeWithEdgeTtsTests(unittest.TestCase):
    def test_passes_rate_to_communicate_when_provided(self):
        captured = {}

        class FakeCommunicate:
            def __init__(self, text, voice, rate=None):
                captured["text"] = text
                captured["voice"] = voice
                captured["rate"] = rate

            async def stream(self):
                yield {"type": "audio", "data": b"abc"}

        original_communicate = edge_tts_server.edge_tts.Communicate
        edge_tts_server.edge_tts.Communicate = FakeCommunicate
        try:
            audio = asyncio.run(
                edge_tts_server.synthesize_with_edge_tts(
                    "hello",
                    "zh-CN-XiaoxiaoNeural",
                    rate="1.4",
                )
            )
        finally:
            edge_tts_server.edge_tts.Communicate = original_communicate

        self.assertEqual(audio, b"abc")
        self.assertEqual(captured["text"], "hello")
        self.assertEqual(captured["voice"], "zh-CN-XiaoxiaoNeural")
        self.assertEqual(captured["rate"], "1.4")


class SynthesizeSpeechTests(unittest.TestCase):
    def test_request_rate_flows_into_edge_tts_synthesis(self):
        captured = {}

        async def fake_resolve_requested_voice(requested_voice):
            captured["requested_voice"] = requested_voice
            return "zh-CN-XiaoxiaoNeural"

        async def fake_synthesize_with_edge_tts(text, voice_name, rate=None):
            captured["text"] = text
            captured["voice_name"] = voice_name
            captured["rate"] = rate
            return b"abc"

        original_resolve = edge_tts_server.resolve_requested_voice
        original_synthesize = edge_tts_server.synthesize_with_edge_tts
        edge_tts_server.resolve_requested_voice = fake_resolve_requested_voice
        edge_tts_server.synthesize_with_edge_tts = fake_synthesize_with_edge_tts
        try:
            response = asyncio.run(
                edge_tts_server.synthesize_speech(
                    edge_tts_server.TTSRequest(
                        text="hello",
                        voice="edge-tts-zh",
                        rate="1.4",
                    )
                )
            )
        finally:
            edge_tts_server.resolve_requested_voice = original_resolve
            edge_tts_server.synthesize_with_edge_tts = original_synthesize

        self.assertEqual(response.body, b"abc")
        self.assertEqual(response.headers["x-tts-engine"], "edge_tts")
        self.assertEqual(captured["requested_voice"], "edge-tts-zh")
        self.assertEqual(captured["text"], "hello")
        self.assertEqual(captured["voice_name"], "zh-CN-XiaoxiaoNeural")
        self.assertEqual(captured["rate"], "1.4")


if __name__ == "__main__":
    unittest.main()
