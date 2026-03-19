import redis.asyncio as redis

class RedisManager:
    _client: redis.Redis | None = None

    @classmethod
    async def init(cls):
        cls._client = redis.Redis(
            host="localhost",
            port=31200,
            db=0,
            decode_responses=True,
            max_connections=100,
        )

    @classmethod
    def get_client(cls) -> redis.Redis:
        return cls._client
    
    @classmethod
    async def close(cls):
        if cls._client:
            await cls._client.aclose()