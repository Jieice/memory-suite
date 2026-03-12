import os
import tempfile
import time
from pathlib import Path
from typing import Iterable

import edge_tts
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

try:
    from win32com.client import Dispatch
except Exception:  # pragma: no cover - only used on Windows fallback hosts
    Dispatch = None

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OUTPUT_DIR = Path(__file__).resolve().parent / "audio_cache"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_VOICE = os.environ.get("EDGE_TTS_DEFAULT_VOICE", "zh-CN-XiaoxiaoNeural")
VOICE_PREFERENCES = {
    "edge-tts-zh": [
        "zh-CN-XiaoxiaoNeural",
        "zh-CN-XiaoyiNeural",
        "zh-CN-YunjianNeural",
        "zh-CN-YunxiNeural",
        "zh-CN-YunxiaNeural",
        "zh-CN-YunyangNeural",
    ],
    "edge-tts-en": [
        "en-US-JennyNeural",
        "en-US-AvaNeural",
        "en-US-EmmaNeural",
        "en-US-GuyNeural",
        "en-US-AndrewNeural",
    ],
}


class TTSRequest(BaseModel):
    character_name: str = "feibi"
    text: str
    voice: str | None = None
    rate: str | None = None


def choose_voice_from_names(requested_voice: str | None, available_names: Iterable[str]) -> str:
    names = [name for name in available_names if name]
    if not names:
        return DEFAULT_VOICE

    if requested_voice and requested_voice in names:
        return requested_voice

    normalized = (requested_voice or "").strip().lower()
    preferred: list[str] = []
    if normalized in VOICE_PREFERENCES:
        preferred.extend(VOICE_PREFERENCES[normalized])
    elif normalized.startswith("zh") or normalized.endswith("-zh"):
        preferred.extend(VOICE_PREFERENCES["edge-tts-zh"])
    elif normalized.startswith("en") or normalized.endswith("-en"):
        preferred.extend(VOICE_PREFERENCES["edge-tts-en"])

    if DEFAULT_VOICE not in preferred:
        preferred.append(DEFAULT_VOICE)

    for candidate in preferred:
        if candidate in names:
            return candidate

    chinese_voice = next((name for name in names if name.startswith("zh-CN-")), None)
    if chinese_voice:
        return chinese_voice

    english_voice = next((name for name in names if name.startswith("en-US-")), None)
    if english_voice:
        return english_voice

    return names[0]


DIRECT_VOICE_ALIASES = {
    "edge-tts-zh": "zh-CN-XiaoxiaoNeural",
    "edge-tts-en": "en-US-JennyNeural",
}
VOICE_LIST_CACHE_TTL_SECONDS = 900
_voice_list_cache: tuple[float, list[str]] | None = None


async def get_available_voice_names() -> list[str]:
    global _voice_list_cache

    now = time.monotonic()
    if _voice_list_cache is not None:
        cached_at, names = _voice_list_cache
        if now - cached_at <= VOICE_LIST_CACHE_TTL_SECONDS:
            return names

    voices = await edge_tts.list_voices()
    names = [voice.get("ShortName") for voice in voices if voice.get("ShortName")]
    _voice_list_cache = (now, names)
    return names


async def resolve_requested_voice(requested_voice: str | None) -> str:
    normalized = (requested_voice or "").strip().lower()
    if normalized in DIRECT_VOICE_ALIASES:
        return DIRECT_VOICE_ALIASES[normalized]

    names = await get_available_voice_names()
    return choose_voice_from_names(requested_voice, names)


def normalize_edge_tts_rate(rate: str | None) -> str:
    if rate is None:
        return "+0%"

    raw = str(rate).strip()
    if not raw:
        return "+0%"

    if raw.endswith("%") and (raw.startswith("+") or raw.startswith("-")):
        return raw

    multiplier = float(raw)
    percent_delta = round((multiplier - 1.0) * 100)
    sign = "+" if percent_delta >= 0 else ""
    return f"{sign}{percent_delta}%"


async def stream_edge_tts_audio(text: str, voice_name: str, rate: str | None = None):
    communicate = edge_tts.Communicate(text, voice_name, rate=normalize_edge_tts_rate(rate))
    yielded_audio = False
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            yielded_audio = True
            yield chunk["data"]

    if not yielded_audio:
        raise RuntimeError("Edge TTS returned no audio data")


async def synthesize_with_edge_tts(text: str, voice_name: str, rate: str | None = None) -> bytes:
    audio_chunks = []
    async for chunk in stream_edge_tts_audio(text, voice_name, rate=rate):
        audio_chunks.append(chunk)
    return b"".join(audio_chunks)


def synthesize_with_windows_sapi(text: str) -> bytes:
    if os.name != "nt" or Dispatch is None:
        raise RuntimeError("Windows SAPI fallback is unavailable on this host")

    temp_file = tempfile.NamedTemporaryFile(
        suffix=".wav",
        dir=str(OUTPUT_DIR),
        delete=False,
    )
    temp_file.close()
    temp_path = Path(temp_file.name)

    try:
        voice = Dispatch("SAPI.SpVoice")
        stream = Dispatch("SAPI.SpFileStream")
        stream.Format.Type = 22
        stream.Open(str(temp_path), 3, False)
        voice.AudioOutputStream = stream
        voice.Speak(text, 0)
        voice.WaitUntilDone(30000)
        stream.Close()

        audio = temp_path.read_bytes()
        if len(audio) <= 46:
            raise RuntimeError("Windows SAPI produced no audio data")
        return audio
    finally:
        if temp_path.exists():
            temp_path.unlink()


@app.post("/tts")
async def synthesize_speech(request: TTSRequest):
    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    try:
        resolved_voice = await resolve_requested_voice(request.voice)
    except Exception as error:
        resolved_voice = DEFAULT_VOICE
        edge_error = RuntimeError(f"voice resolution failed: {error}")
    else:
        edge_error = None

    try:
        return StreamingResponse(
            stream_edge_tts_audio(request.text, resolved_voice, request.rate),
            media_type="audio/mpeg",
            headers={
                "x-tts-engine": "edge_tts",
                "x-tts-voice": resolved_voice,
            },
        )
    except Exception as error:
        edge_error = edge_error or error

    try:
        audio_data = synthesize_with_windows_sapi(request.text)
        return Response(
            content=audio_data,
            media_type="audio/wav",
            headers={
                "x-tts-engine": "windows_sapi",
                "x-tts-voice": resolved_voice,
            },
        )
    except Exception as fallback_error:
        raise HTTPException(
            status_code=500,
            detail=(
                f"TTS failed: edge={edge_error}; "
                f"fallback={fallback_error}"
            ),
        )


@app.get("/voices")
async def list_voices():
    try:
        names = await get_available_voice_names()
        return {
            "voice": choose_voice_from_names(None, names),
            "available": True,
            "engine": "edge_tts",
            "count": len(names),
        }
    except Exception as error:
        return {
            "voice": DEFAULT_VOICE,
            "available": os.name == "nt" and Dispatch is not None,
            "engine": "windows_sapi",
            "detail": str(error),
        }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("EDGE_TTS_PORT", "9881"))
    print(f"[Edge-TTS] Starting server on port {port}")
    print(f"[Edge-TTS] Default voice: {DEFAULT_VOICE}")
    uvicorn.run(app, host="0.0.0.0", port=port)
