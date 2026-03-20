from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from redis_hanlder import RedisManager
from regist_url_id import init_model_list, register_url, delete_url, delete_all_urls, get_url
import requests

@asynccontextmanager
async def lifespan(app: FastAPI):
    await RedisManager.init()
    await init_model_list()
    yield
    await RedisManager.close()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/front", StaticFiles(directory="front"), name="front")


class RegisterUrlRequest(BaseModel):
    model_name: str
    url_id: str
    is_on: bool = True


@app.get("/")
async def root():
    return {"message": "RUNPOD URL SELECTOR SERVER"}


@app.post("/register_url")
async def post_register_url(req: RegisterUrlRequest):
    try:
        updated = await register_url(req.model_name, req.url_id, req.is_on)
        return {"registered": True, "updated": updated}
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/delete_url")
async def delete_url_endpoint(model_name: str):
    try:
        deleted = await delete_url(model_name)
        return {"deleted": deleted}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/delete_all_urls")
async def delete_all_urls_endpoint():
    try:
        count = await delete_all_urls()
        return {"deleted": count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/get_url")
def get_url_endpoint(model_name: str):
    url = get_url(model_name)
    if url is None:
        raise HTTPException(status_code=404, detail="model not registered or offline")
    return {"model_name": model_name, "url": url}

class BenchmarkRequest(BaseModel):
    url_id: str
    gpu: str
    rounds: int = 3
    max_tokens: int = 256

from fastapi.responses import StreamingResponse
from benchmark import run_benchmark_stream, load_all_logs
import json as _json

def _sse_generator(req: BenchmarkRequest):
    url = f"https://{req.url_id}-8000.proxy.runpod.net/"

    model_info = requests.get(f"{url}v1/models")
    if model_info.status_code != 200:
        yield f"data: {_json.dumps({'event': 'error', 'detail': 'Failed to get model info'})}\n\n"
        return

    model_name = model_info.json()['data'][0]['id']

    for event in run_benchmark_stream(url, model_name, req.gpu, req.url_id, req.rounds, req.max_tokens):
        yield f"data: {_json.dumps(event)}\n\n"

@app.post("/benchmark")
async def benchmark_endpoint(req: BenchmarkRequest):
    return StreamingResponse(
        _sse_generator(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/benchmark/logs")
def benchmark_logs_endpoint():
    return load_all_logs()