import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from redis_hanlder import RedisManager
from regist_url_id import register_url, delete_url, delete_all_urls, get_url
import requests

@asynccontextmanager
async def lifespan(app: FastAPI):
    await RedisManager.init()
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
async def get_url_endpoint(model_name: str):
    url = await get_url(model_name)
    if url is None:
        raise HTTPException(status_code=404, detail="model not registered or offline")
    return {"model_name": model_name, "url": url}

class BenchmarkRequest(BaseModel):
    mode: str = "runpod"  # "runpod" or "api"
    # RunPod mode fields
    url_id: str | None = None
    gpu: str | None = None
    gpu_count: int = 1
    # API mode fields
    api_base: str | None = None
    api_key: str | None = None
    model: str | None = None
    provider: str | None = None
    # Common
    rounds: int = 3
    max_tokens: int = 8192

from fastapi.responses import StreamingResponse
from benchmark import run_benchmark_stream, load_all_logs
from load_test import run_load_test_stream, load_all_load_test_logs
import json as _json

class LoadTestConfig(BaseModel):
    mode: str = "runpod"
    url_id: str | None = None
    gpu: str | None = None
    gpu_count: int = 1
    api_base: str | None = None
    api_key: str | None = None
    model: str | None = None
    provider: str | None = None
    rounds: int = 1
    max_tokens: int = 8192
    steps: list[int] = [1, 3, 5, 10, 20]

def _sse_generator(req: BenchmarkRequest):
    if req.mode == "api":
        # API mode
        if not req.api_base or not req.api_key or not req.model:
            yield f"data: {_json.dumps({'event': 'error', 'detail': 'api_base, api_key, model are required for API mode'})}\n\n"
            return

        provider = req.provider or "API"
        url_id = provider.lower().replace(" ", "-")
        headers = {"Authorization": f"Bearer {req.api_key}"}

        for event in run_benchmark_stream(
            req.api_base, req.model, provider, url_id,
            req.rounds, req.max_tokens, gpu_count=1, headers=headers,
        ):
            yield f"data: {_json.dumps(event)}\n\n"
    else:
        # RunPod mode
        if not req.url_id or not req.gpu:
            yield f"data: {_json.dumps({'event': 'error', 'detail': 'url_id, gpu are required for RunPod mode'})}\n\n"
            return

        url = f"https://{req.url_id}-8000.proxy.runpod.net/"

        model_info = requests.get(f"{url}v1/models", timeout=10)
        if model_info.status_code != 200:
            yield f"data: {_json.dumps({'event': 'error', 'detail': 'Failed to get model info'})}\n\n"
            return
        try:
            model_name = (model_info.json().get("data") or [])[0]["id"]
        except (ValueError, KeyError, IndexError) as exc:
            yield f"data: {_json.dumps({'event': 'error', 'detail': f'Unexpected model info response: {exc}'})}\n\n"
            return

        for event in run_benchmark_stream(url, model_name, req.gpu, req.url_id, req.rounds, req.max_tokens, gpu_count=req.gpu_count):
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


async def _load_test_sse_generator(req: LoadTestConfig):
    if req.mode == "api":
        if not req.api_base or not req.api_key or not req.model:
            yield f"data: {_json.dumps({'event': 'error', 'detail': 'api_base, api_key, model are required'})}\n\n"
            return
        provider = req.provider or "API"
        url_id = provider.lower().replace(" ", "-")
        headers = {"Authorization": f"Bearer {req.api_key}"}
        async for event in run_load_test_stream(
            req.api_base, req.model, provider, url_id,
            req.steps, req.rounds, req.max_tokens, gpu_count=1, headers=headers,
        ):
            yield f"data: {_json.dumps(event)}\n\n"
    else:
        if not req.url_id or not req.gpu:
            yield f"data: {_json.dumps({'event': 'error', 'detail': 'url_id and gpu are required'})}\n\n"
            return
        url = f"https://{req.url_id}-8000.proxy.runpod.net/"
        model_info = await asyncio.to_thread(requests.get, f"{url}v1/models", timeout=10)
        if model_info.status_code != 200:
            yield f"data: {_json.dumps({'event': 'error', 'detail': 'Failed to get model info'})}\n\n"
            return
        try:
            model_name = (model_info.json().get("data") or [])[0]["id"]
        except (ValueError, KeyError, IndexError) as exc:
            yield f"data: {_json.dumps({'event': 'error', 'detail': f'Unexpected model info response: {exc}'})}\n\n"
            return
        async for event in run_load_test_stream(
            url, model_name, req.gpu, req.url_id,
            req.steps, req.rounds, req.max_tokens, gpu_count=req.gpu_count,
        ):
            yield f"data: {_json.dumps(event)}\n\n"


@app.post("/load-test")
async def load_test_endpoint(req: LoadTestConfig):
    return StreamingResponse(
        _load_test_sse_generator(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/load-test/logs")
def load_test_logs_endpoint():
    return load_all_load_test_logs()


# ── Vision proxy ───────────────────────────────────────────────────
class VisionConnectRequest(BaseModel):
    url_id: str

class VisionChatRequest(BaseModel):
    url_id: str
    question: str
    image_data_url: str | None = None   # data:mime;base64,... — optional
    max_tokens: int = 2048

@app.post("/vision/connect")
async def vision_connect(req: VisionConnectRequest):
    base = f"https://{req.url_id}-8000.proxy.runpod.net"
    try:
        health = await asyncio.to_thread(requests.get, f"{base}/health", timeout=10)
        if health.status_code != 200:
            raise HTTPException(status_code=502, detail=f"health returned {health.status_code}")
        models = await asyncio.to_thread(requests.get, f"{base}/v1/models", timeout=10)
        if models.status_code != 200:
            raise HTTPException(status_code=502, detail=f"models returned {models.status_code}")
        data = models.json().get("data") or []
        model_id = data[0]["id"] if data else ""
        return {"model_id": model_id}
    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=502, detail=str(e))

def _vision_stream(req: VisionChatRequest):
    import json as _j
    base = f"https://{req.url_id}-8000.proxy.runpod.net"

    # Resolve model id
    try:
        models_resp = requests.get(f"{base}/v1/models", timeout=10)
        model_id = (models_resp.json().get("data") or [])[0]["id"]
    except Exception as e:
        yield f"data: {_j.dumps({'error': str(e)})}\n\n"
        return

    content: list = [{"type": "text", "text": req.question}]
    if req.image_data_url:
        content.append({"type": "image_url", "image_url": {"url": req.image_data_url}})

    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": content}],
        "stream": True,
        "max_tokens": req.max_tokens,
    }

    try:
        with requests.post(
            f"{base}/v1/chat/completions",
            json=payload,
            stream=True,
            timeout=120,
        ) as resp:
            if resp.status_code != 200:
                yield f"data: {_j.dumps({'error': f'HTTP {resp.status_code}'})}\n\n"
                return
            for raw in resp.iter_lines():
                if not raw:
                    continue
                line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
                # Forward SSE lines as-is
                yield line + "\n\n"
    except Exception as e:
        yield f"data: {_j.dumps({'error': str(e)})}\n\n"

@app.post("/vision/chat")
async def vision_chat(req: VisionChatRequest):
    return StreamingResponse(
        _vision_stream(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )