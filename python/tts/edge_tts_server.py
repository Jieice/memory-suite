import asyncio
import os
import sys
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
import edge_tts
import uuid

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

VOICE = "zh-CN-XiaoxuanNeural"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio_cache")
os.makedirs(OUTPUT_DIR, exist_ok=True)

class TTSRequest(BaseModel):
    character_name: str = "feibi"
    text: str

@app.post("/tts")
async def synthesize_speech(request: TTSRequest):
    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    try:
        communicate = edge_tts.Communicate(request.text, VOICE)
        audio_chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_chunks.append(chunk["data"])

        if not audio_chunks:
            raise Exception("Edge TTS returned no audio data")

        audio_data = b"".join(audio_chunks)
        return Response(content=audio_data, media_type="audio/mpeg")

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS failed: {str(e)}")

@app.get("/voices")
async def list_voices():
    return {"voice": VOICE, "available": True}

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("EDGE_TTS_PORT", "9881"))
    print(f"[Edge-TTS] Starting server on port {port}")
    print(f"[Edge-TTS] Using voice: {VOICE}")
    uvicorn.run(app, host="0.0.0.0", port=port)
