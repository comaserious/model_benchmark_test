import logging
import re

from redis_hanlder import RedisManager

logger = logging.getLogger(__name__)

MODEL_LIST: dict[str, dict] = {}

_MODEL_NAME_RE = re.compile(r"^[a-zA-Z0-9_./-]+$")


def _validate_inputs(model_name: str, url_id: str) -> None:
    if not _MODEL_NAME_RE.match(model_name):
        raise ValueError(
            f"model_name '{model_name}' is invalid. "
            "Only alphanumeric characters, hyphens, and underscores are allowed."
        )
    if not url_id:
        raise ValueError("url_id must not be empty.")


async def init_model_list() -> None:
    """Load all runpod:* Redis hashes into MODEL_LIST at startup."""
    redis = RedisManager.get_client()
    keys = await redis.keys("runpod:*")
    for key in keys:
        model_name = key.split(":", 1)[1]
        data = await redis.hgetall(key)
        if "url_id" not in data or "is_on" not in data:
            logger.warning("Skipping incomplete Redis key '%s' (missing fields)", key)
            continue
        MODEL_LIST[model_name] = {
            "url_id": data["url_id"],
            "is_on": data["is_on"] == "true",
        }


async def register_url(model_name: str, url_id: str, is_on: bool = True) -> bool:
    """Register or update a RunPod pod URL. Returns True if changed, False if no-op."""
    # 1. No-op check FIRST (before validation)
    existing = MODEL_LIST.get(model_name)
    if existing and existing["url_id"] == url_id and existing["is_on"] == is_on:
        return False

    # 2. Validate
    _validate_inputs(model_name, url_id)

    # 3. Write to Redis
    redis = RedisManager.get_client()
    await redis.hset(
        f"runpod:{model_name}",
        mapping={"url_id": url_id, "is_on": "true" if is_on else "false"},
    )
    await redis.expire(f"runpod:{model_name}", 86400)  # 24시간 TTL

    # 4. Update in-memory cache
    MODEL_LIST[model_name] = {"url_id": url_id, "is_on": is_on}
    return True


async def delete_url(model_name: str) -> bool:
    """Remove a RunPod pod URL. Returns True if deleted, False if not registered."""
    if model_name not in MODEL_LIST:
        return False

    redis = RedisManager.get_client()
    await redis.delete(f"runpod:{model_name}")  # DEL returning 0 is not an error
    del MODEL_LIST[model_name]
    return True


async def delete_all_urls() -> int:
    """Remove all registered URLs. Returns number of deleted entries."""
    if not MODEL_LIST:
        return 0

    redis = RedisManager.get_client()
    keys = [f"runpod:{name}" for name in MODEL_LIST]
    await redis.delete(*keys)
    count = len(MODEL_LIST)
    MODEL_LIST.clear()
    return count


def get_url(model_name: str) -> str | None:
    """Return the full URL for a model if registered and online. Sync, memory-only."""
    entry = MODEL_LIST.get(model_name)
    if entry and entry["is_on"]:
        return f"https://{entry['url_id']}.proxy.runpod.net/"
    return None
