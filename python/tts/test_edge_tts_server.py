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
    def test_converts_multiplier_rate_to_edge_tts_percent_string(self):
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
        self.assertEqual(captured["rate"], "+40%")


class ResolveRequestedVoiceTests(unittest.TestCase):
    def test_known_alias_resolves_without_listing_voices(self):
        async def fake_list_voices():
            raise AssertionError("known alias should not trigger edge_tts.list_voices")

        original_list_voices = edge_tts_server.edge_tts.list_voices
        original_cache = edge_tts_server._voice_list_cache
        edge_tts_server._voice_list_cache = None
        edge_tts_server.edge_tts.list_voices = fake_list_voices
        try:
            resolved = asyncio.run(edge_tts_server.resolve_requested_voice("edge-tts-zh"))
        finally:
            edge_tts_server.edge_tts.list_voices = original_list_voices
            edge_tts_server._voice_list_cache = original_cache

        self.assertEqual(resolved, "zh-CN-XiaoxiaoNeural")

    def test_exact_voice_resolution_reuses_cached_voice_list(self):
        calls = 0

        async def fake_list_voices():
            nonlocal calls
            calls += 1
            return [
                {"ShortName": "zh-CN-XiaoxiaoNeural"},
                {"ShortName": "en-US-JennyNeural"},
            ]

        original_list_voices = edge_tts_server.edge_tts.list_voices
        original_cache = edge_tts_server._voice_list_cache
        edge_tts_server._voice_list_cache = None
        edge_tts_server.edge_tts.list_voices = fake_list_voices
        try:
            first = asyncio.run(edge_tts_server.resolve_requested_voice("zh-CN-XiaoxiaoNeural"))
            second = asyncio.run(edge_tts_server.resolve_requested_voice("zh-CN-XiaoxiaoNeural"))
        finally:
            edge_tts_server.edge_tts.list_voices = original_list_voices
            edge_tts_server._voice_list_cache = original_cache

        self.assertEqual(first, "zh-CN-XiaoxiaoNeural")
        self.assertEqual(second, "zh-CN-XiaoxiaoNeural")
        self.assertEqual(calls, 1)


class ListVoicesTests(unittest.TestCase):
    def test_list_voices_reuses_cached_voice_names(self):
        calls = 0

        async def fake_list_voices():
            nonlocal calls
            calls += 1
            return [
                {"ShortName": "zh-CN-XiaoxiaoNeural"},
                {"ShortName": "en-US-JennyNeural"},
            ]

        original_list_voices = edge_tts_server.edge_tts.list_voices
        original_cache = edge_tts_server._voice_list_cache
        edge_tts_server._voice_list_cache = None
        edge_tts_server.edge_tts.list_voices = fake_list_voices
        try:
            first = asyncio.run(edge_tts_server.list_voices())
            second = asyncio.run(edge_tts_server.list_voices())
        finally:
            edge_tts_server.edge_tts.list_voices = original_list_voices
            edge_tts_server._voice_list_cache = original_cache

        self.assertTrue(first["available"])
        self.assertEqual(first["engine"], "edge_tts")
        self.assertEqual(first["voice"], "zh-CN-XiaoxiaoNeural")
        self.assertEqual(second["voice"], "zh-CN-XiaoxiaoNeural")
        self.assertEqual(calls, 1)


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
