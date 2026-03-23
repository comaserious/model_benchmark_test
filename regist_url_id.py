import logging
import re

import redis as sync_redis
from redis_hanlder import RedisManager

_sync_pool = sync_redis.ConnectionPool(
    host="localhost", port=31200, db=0,
    decode_responses=True, max_connections=20,
)


logger = logging.getLogger(__name__)

_MODEL_NAME_RE = re.compile(r"^[a-zA-Z0-9_./-]+$")


def _validate_inputs(model_name: str, url_id: str) -> None:
    if not _MODEL_NAME_RE.match(model_name):
        raise ValueError(
            f"model_name '{model_name}' is invalid. "
            "Only alphanumeric characters, hyphens, and underscores are allowed."
        )
    if not url_id:
        raise ValueError("url_id must not be empty.")


async def register_url(model_name: str, url_id: str, is_on: bool = True) -> bool:
    """Register or update a RunPod pod URL. Returns True if changed, False if no-op."""
    _validate_inputs(model_name, url_id)

    redis = RedisManager.get_client()
    key = f"runpod:{model_name}"

    existing = await redis.hgetall(key)
    if (
        existing
        and existing.get("url_id") == url_id
        and existing.get("is_on") == ("true" if is_on else "false")
    ):
        return False

    await redis.hset(key, mapping={"url_id": url_id, "is_on": "true" if is_on else "false"})
    await redis.expire(key, 86400)
    return True


async def delete_url(model_name: str) -> bool:
    """Remove a RunPod pod URL. Returns True if deleted, False if not registered."""
    redis = RedisManager.get_client()
    deleted = await redis.delete(f"runpod:{model_name}")
    return deleted > 0


async def delete_all_urls() -> int:
    """Remove all registered URLs. Returns number of deleted entries."""
    redis = RedisManager.get_client()
    keys = await redis.keys("runpod:*")
    if not keys:
        return 0
    return await redis.delete(*keys)


async def get_url(model_name: str) -> str | None:
    """Return the full URL for a model if registered and online."""
    redis = RedisManager.get_client()
    data = await redis.hgetall(f"runpod:{model_name}")
    if data and data.get("is_on") == "true":
        return f"https://{data['url_id']}.proxy.runpod.net/"
    return None


def get_url_sync(model_name: str) -> str | None:
    """Sync version of get_url. For use in non-async contexts (e.g. __init__)."""
    r = sync_redis.Redis(connection_pool=_sync_pool)
    data = r.hgetall(f"runpod:{model_name}")
    if data and data.get("is_on") == "true":
        return f"https://{data['url_id']}.proxy.runpod.net/"
    return None
