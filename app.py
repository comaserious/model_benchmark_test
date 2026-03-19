from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from redis_hanlder import RedisManager
from regist_url_id import init_model_list, register_url, delete_url, get_url


@asynccontextmanager
async def lifespan(app: FastAPI):
    await RedisManager.init()
    await init_model_list()
    yield
    await RedisManager.close()


app = FastAPI(lifespan=lifespan)


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


@app.delete("/delete_url/{model_name}")
async def delete_url_endpoint(model_name: str):
    try:
        deleted = await delete_url(model_name)
        return {"deleted": deleted}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/get_url/{model_name}")
def get_url_endpoint(model_name: str):
    url = get_url(model_name)
    if url is None:
        raise HTTPException(status_code=404, detail="model not registered or offline")
    return {"model_name": model_name, "url": url}
