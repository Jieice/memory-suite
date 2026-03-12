import asyncio
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
import uvicorn

app = FastAPI()

@app.get('/fake-stream')
async def fake_stream():
    async def gen():
        yield b'first-chunk'
        await asyncio.sleep(1.5)
        yield b'second-chunk'
    return StreamingResponse(gen(), media_type='application/octet-stream')

if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=18991)
