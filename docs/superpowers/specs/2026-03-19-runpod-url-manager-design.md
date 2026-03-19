# RunPod URL Manager — Design Spec
Date: 2026-03-19

## Problem

RunPod pods get a new URL every time they start (e.g., `https://926nu5ynhd9sib-8000.proxy.runpod.net/`). We need a central registry that tracks which URL belongs to which model, persists across server restarts via Redis, and serves URLs to both internal Python callers and external HTTP clients.

## Constraints

- One pod per model at any given time
- `is_on=True` means the pod is alive; only live pods return URLs
- All Redis I/O must be async (`redis.asyncio`)
- `get_url` must also work as a synchronous in-process Python function call
- Internal-only server; callers are trusted internal services. No auth required.

## Known Limitations

- **Cache staleness**: `get_url` reads only from `MODEL_LIST` (no Redis fallback on miss). If a pod is registered by an external process, this server's cache won't reflect it until a `/register_url` call is made or the server restarts. Accepted limitation.
- **No TTL / heartbeat**: Crashed pods leave stale Redis entries until `/delete_url` is called. No expiry mechanism. Deferred to future work.

---

## Redis Data Structure

```
Key:   runpod:{model_name}
Type:  Hash
Fields:
  url_id  →  string        (e.g., "926nu5ynhd9sib-8000")
  is_on   →  "true"|"false"  (always lowercase string)
```

Full URL assembled at query time: `https://{url_id}.proxy.runpod.net/`

### Type Contract

| Layer | `is_on` type |
|---|---|
| Pydantic (HTTP input) | `bool` |
| Redis storage | `"true"` or `"false"` (lowercase string) |
| `MODEL_LIST` in-memory | `bool` |

Serialization: `bool → str`: `True → "true"`, `False → "false"`
Deserialization: `str → bool`: `value == "true"` (all other strings → `False`)

---

## Module: `regist_url_id.py`

```python
MODEL_LIST: dict[str, dict]
# e.g. {"llama3": {"url_id": "926nu5ynhd9sib-8000", "is_on": True}}
#                                                             ^^^^^ bool
```

### Input Validation

`model_name` must match `^[a-zA-Z0-9_-]+$` (alphanumeric, hyphens, underscores only — no `:`, spaces, or slashes). `url_id` must be non-empty. Raise `ValueError` with a descriptive message on violation.

---

### `async init_model_list() -> None`

- Scans Redis for all keys matching `"runpod:*"` via `keys("runpod:*")`
- For each key, calls `HGETALL`
- If `url_id` or `is_on` field is missing, skip that key and log a warning
- Deserializes `is_on` string → bool using `value == "true"`
- Populates `MODEL_LIST` with `{"url_id": str, "is_on": bool}`

---

### `async register_url(model_name: str, url_id: str, is_on: bool = True) -> bool`

**Step order:**

1. **No-op check first** (before validation): If `model_name` exists in `MODEL_LIST` and both `url_id == stored url_id` AND `is_on == stored is_on`, return `False` immediately. No validation, no Redis call.
2. **Validate**: `model_name` matches `^[a-zA-Z0-9_-]+$`, `url_id` is non-empty. Raise `ValueError` on violation.
3. **Write to Redis**: `HSET runpod:{model_name} url_id {url_id} is_on {"true"|"false"}`
4. **Update MODEL_LIST**: `MODEL_LIST[model_name] = {"url_id": url_id, "is_on": is_on}`
5. Return `True`

Raises `Exception` on Redis write failure (never returns `False` for errors).

---

### `async delete_url(model_name: str) -> bool`

1. If `model_name` not in `MODEL_LIST`: return `False` immediately (idempotent, no Redis call)
2. Delete Redis key: `DEL runpod:{model_name}`
3. If `DEL` returns 0 (key was already absent from Redis): still proceed — this is not an error
4. Remove `MODEL_LIST[model_name]`
5. Return `True`

Raises `Exception` on Redis connection/command failure (not on DEL returning 0).

---

### `get_url(model_name: str) -> str | None`  ← **SYNC, memory-only**

- Reads from `MODEL_LIST` only. No Redis I/O.
- If `model_name` is in `MODEL_LIST` and `is_on is True`: returns `f"https://{url_id}.proxy.runpod.net/"`
- Otherwise returns `None`

> **Thread safety note**: FastAPI runs plain `def` endpoints in a threadpool. `MODEL_LIST` is a Python dict; CPython's GIL provides sufficient protection for individual dict reads/writes. No explicit lock is needed for this use case.

---

## HTTP API (`app.py`)

### Pydantic Request Model

```python
class RegisterUrlRequest(BaseModel):
    model_name: str   # required
    url_id: str       # required
    is_on: bool = True
```

### Endpoints

#### `POST /register_url`

- Calls `await register_url(req.model_name, req.url_id, req.is_on)`
- Catches `ValueError` → re-raises as `HTTPException(status_code=422, detail=str(e))`
- Catches other `Exception` → re-raises as `HTTPException(status_code=500, detail=str(e))`
- Returns `{"registered": True, "updated": True}` if updated, `{"registered": True, "updated": False}` if no-op

#### `DELETE /delete_url/{model_name}`

- Calls `await delete_url(model_name)`
- If returns `True` → `200 {"deleted": True}`
- If returns `False` (model not found) → **`200 {"deleted": False}`** (idempotent; no 404)
- Catches `Exception` → `HTTPException(500)`

#### `GET /get_url/{model_name}`  ← **plain `def`, not `async def`**

- Calls `get_url(model_name)` (sync, memory-only)
- If URL returned → `200 {"model_name": model_name, "url": url}`
- If `None` → `HTTPException(status_code=404, detail="model not registered or offline")`

---

## Error Handling Summary

| Situation | Internal function | HTTP response |
|---|---|---|
| Model not registered | `None` / `False` | `GET` 404, `DELETE` 200 |
| `is_on=False` | `None` | 404 |
| Identical entry (same url_id AND is_on) | `False` | `200 updated:false` |
| Invalid `model_name` / `url_id` | `ValueError` | 422 (caught and re-raised) |
| Redis connection failure | raise `Exception` | 500 |

---

## Startup Flow

```python
# app.py lifespan
await RedisManager.init()
await init_model_list()    # ← must be awaited (current code is missing await — bug to fix)
```

---

## Lifecycle Flow

```
Pod starts  → POST /register_url {model_name, url_id}
              → Redis HSET + MODEL_LIST updated

Pod stops   → DELETE /delete_url/{model_name}
              → Redis DEL + MODEL_LIST entry removed
              (returns 200 even if already deleted — idempotent)

URL needed  → get_url("llama3")        # in-process sync call
              GET /get_url/llama3       # HTTP
              → returns URL if is_on=True, else None/404
```

---

## Files Changed

| File | Change |
|---|---|
| `regist_url_id.py` | Full rewrite: async, Redis Hash, correct type contracts, `delete_url`, `get_url` |
| `app.py` | Fix missing `await` on `init_model_list()`, add 3 endpoints |
| `redis_hanlder.py` | No change |
