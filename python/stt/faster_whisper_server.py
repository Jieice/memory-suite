import argparse
import base64
import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    from faster_whisper import WhisperModel
except Exception as import_error:  # pragma: no cover - runtime dependency probe
    WhisperModel = None
    IMPORT_ERROR = import_error
else:
    IMPORT_ERROR = None

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 9882
DEFAULT_MODEL = os.getenv("MEMORY_SUITE_STT_MODEL", "small")
DEFAULT_DEVICE = os.getenv("MEMORY_SUITE_STT_DEVICE", "cpu")
DEFAULT_COMPUTE_TYPE = os.getenv("MEMORY_SUITE_STT_COMPUTE_TYPE", "int8")

MODEL_CACHE: dict[tuple[str, str, str], WhisperModel] = {}


class TranscribeRequest(BaseModel):
    audio_base64: str
    mime_type: str | None = None
    model: str | None = None
    language: str | None = None
    prompt: str | None = None


def normalize_language(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


def resolve_suffix(mime_type: str | None) -> str:
    normalized = (mime_type or "").lower()
    if "wav" in normalized:
        return ".wav"
    if "mpeg" in normalized or "mp3" in normalized:
        return ".mp3"
    if "ogg" in normalized:
        return ".ogg"
    if "webm" in normalized:
        return ".webm"
    return ".wav"


def get_model(model_name: str) -> WhisperModel:
    if WhisperModel is None:
        raise RuntimeError(f"faster-whisper not installed: {IMPORT_ERROR}")

    cache_key = (model_name, DEFAULT_DEVICE, DEFAULT_COMPUTE_TYPE)
    model = MODEL_CACHE.get(cache_key)
    if model is not None:
        return model

    model = WhisperModel(
        model_name,
        device=DEFAULT_DEVICE,
        compute_type=DEFAULT_COMPUTE_TYPE,
    )
    MODEL_CACHE[cache_key] = model
    return model


@app.get("/health")
async def health():
    return {
        "available": WhisperModel is not None,
        "engine": "faster_whisper",
        "default_model": DEFAULT_MODEL,
        "device": DEFAULT_DEVICE,
        "compute_type": DEFAULT_COMPUTE_TYPE,
        "detail": None if IMPORT_ERROR is None else str(IMPORT_ERROR),
    }


@app.post("/transcribe")
async def transcribe(request: TranscribeRequest):
    if not request.audio_base64 or not request.audio_base64.strip():
        raise HTTPException(status_code=400, detail="audio_base64 cannot be empty")

    model_name = (request.model or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    language = normalize_language(request.language)
    prompt = normalize_language(request.prompt)

    try:
        audio_bytes = base64.b64decode(request.audio_base64)
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"invalid audio_base64: {error}") from error

    if not audio_bytes:
        raise HTTPException(status_code=400, detail="decoded audio payload is empty")

    suffix = resolve_suffix(request.mime_type)
    temp_path = None

    try:
        model = get_model(model_name)
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_file.write(audio_bytes)
            temp_path = Path(temp_file.name)

        segments, info = model.transcribe(
            str(temp_path),
            language=language,
            initial_prompt=prompt,
            beam_size=1,
            best_of=1,
            vad_filter=True,
            condition_on_previous_text=False,
            word_timestamps=False,
        )
        text = " ".join(segment.text.strip() for segment in segments if segment.text).strip()
        detected_language = getattr(info, "language", None) or language

        return {
            "text": text,
            "language": detected_language,
            "model": model_name,
            "engine": "faster_whisper",
        }
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"transcription failed: {error}") from error
    finally:
        if temp_path and temp_path.exists():
            try:
                temp_path.unlink()
            except OSError:
                pass


def parse_args():
    parser = argparse.ArgumentParser(description="Run the faster-whisper STT adapter server.")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    return parser.parse_args()


def main():
    import uvicorn

    args = parse_args()
    print(f"[faster-whisper] Starting server on port {args.port}")
    print(
        f"[faster-whisper] device={DEFAULT_DEVICE} compute_type={DEFAULT_COMPUTE_TYPE} default_model={DEFAULT_MODEL}"
    )
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
