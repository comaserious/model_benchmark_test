from fastapi import FastAPI, HTTPException
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    from redis_hanlder import RedisManager

    await RedisManager.init()

    from regist_url_id import init_model_list
    init_model_list()

    yield

    await RedisManager.close()


app = FastAPI(lifespan=lifespan)

@app.get("/")
async def root():
    return {"message" : "RUNPOD URL SELECTOR SERVER"}

from pydantic import BaseModel

class RunpodUrl(BaseModel):
    url_id: str
    model_name: str
    is_on: bool = True

@app.post("/add_url")
async def add_url(req: RunpodUrl):
    try:
        pass
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
