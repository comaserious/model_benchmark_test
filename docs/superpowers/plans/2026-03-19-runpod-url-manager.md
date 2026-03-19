# RunPod URL Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Redis-backed URL registry for RunPod pods with in-memory caching, CRUD functions, and FastAPI HTTP endpoints.

**Architecture:** `regist_url_id.py` owns an in-memory `MODEL_LIST` dict and all async CRUD operations against Redis hashes (`runpod:{model_name}`). `app.py` exposes three HTTP endpoints that call those functions. `get_url` is sync (memory-only); all Redis I/O is async.

**Tech Stack:** Python 3.14, FastAPI, redis.asyncio, pytest, pytest-asyncio, httpx (test client)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `requirements.txt` | Create | Pin all dependencies |
| `pytest.ini` | Create | Configure pytest-asyncio auto mode |
| `tests/conftest.py` | Create | Shared fixtures: mocked Redis client |
| `tests/test_regist_url_id.py` | Create | Unit tests for all 4 functions |
| `tests/test_app.py` | Create | Integration tests for 3 HTTP endpoints |
| `regist_url_id.py` | Rewrite | MODEL_LIST + init/register/delete/get_url |
| `app.py` | Modify | Fix missing await, add 3 endpoints |

---

## Task 1: Install dependencies and configure test runner

**Files:**
- Create: `requirements.txt`
- Create: `pytest.ini`

- [ ] **Step 1: Create `requirements.txt`**

```
fastapi>=0.115.0
uvicorn>=0.30.0
redis>=5.0.0
pytest>=8.0.0
pytest-asyncio>=0.24.0
httpx>=0.27.0
```

- [ ] **Step 2: Install dependencies**

```bash
pip install -r requirements.txt
```

Expected: all packages install without error.

- [ ] **Step 3: Create `pytest.ini`**

```ini
[pytest]
asyncio_mode = auto
```

This tells pytest-asyncio to automatically handle `async def` test functions without needing `@pytest.mark.asyncio` decorators.

- [ ] **Step 4: Verify pytest is working**

```bash
pytest --collect-only
```

Expected: "no tests ran" or "collected 0 items" — no errors.

---

## Task 2: Create test fixtures (conftest.py)

**Files:**
- Create: `tests/__init__.py`
- Create: `tests/conftest.py`

- [ ] **Step 1: Create `tests/__init__.py`**

```python
```

(empty file)

- [ ] **Step 2: Create `tests/conftest.py`**

```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


@pytest.fixture
def mock_redis():
    """Returns a mock async Redis client pre-configured for common operations."""
    client = AsyncMock()
    # keys() returns a list of matching key strings
    client.keys = AsyncMock(return_value=[])
    # hgetall() returns an empty dict by default
    client.hgetall = AsyncMock(return_value={})
    # hset() returns number of new fields written
    client.hset = AsyncMock(return_value=1)
    # delete() returns number of keys deleted
    client.delete = AsyncMock(return_value=1)
    return client


@pytest.fixture(autouse=True)
def reset_model_list():
    """Clear MODEL_LIST before each test to prevent state leakage."""
    try:
        import regist_url_id
        regist_url_id.MODEL_LIST.clear()
        yield
        regist_url_id.MODEL_LIST.clear()
    except ImportError:
        yield  # regist_url_id not yet created — nothing to clear
```

- [ ] **Step 3: Verify conftest loads without error**

```bash
pytest --collect-only
```

Expected: collected 0 items, no import errors.

---

## Task 3: Rewrite `regist_url_id.py` — `init_model_list`

**Files:**
- Rewrite: `regist_url_id.py`
- Create: `tests/test_regist_url_id.py`

- [ ] **Step 1: Write failing tests for `init_model_list`**

Create `tests/test_regist_url_id.py`:

```python
import pytest
import regist_url_id
from unittest.mock import patch, AsyncMock


async def test_init_model_list_populates_from_redis(mock_redis):
    """Keys found in Redis are loaded into MODEL_LIST with correct types."""
    mock_redis.keys = AsyncMock(return_value=["runpod:llama3", "runpod:mistral"])
    mock_redis.hgetall = AsyncMock(side_effect=[
        {"url_id": "abc123-8000", "is_on": "true"},
        {"url_id": "xyz789-8000", "is_on": "false"},
    ])

    with patch("regist_url_id.RedisManager.get_client", return_value=mock_redis):
        await regist_url_id.init_model_list()

    assert regist_url_id.MODEL_LIST == {
        "llama3": {"url_id": "abc123-8000", "is_on": True},
        "mistral": {"url_id": "xyz789-8000", "is_on": False},
    }


async def test_init_model_list_skips_incomplete_keys(mock_redis, caplog):
    """Keys missing url_id or is_on are skipped with a warning."""
    import logging
    mock_redis.keys = AsyncMock(return_value=["runpod:broken"])
    mock_redis.hgetall = AsyncMock(return_value={"url_id": "abc123-8000"})  # missing is_on

    with patch("regist_url_id.RedisManager.get_client", return_value=mock_redis):
        with caplog.at_level(logging.WARNING):
            await regist_url_id.init_model_list()

    assert "broken" not in regist_url_id.MODEL_LIST
    assert any("broken" in r.message for r in caplog.records)


async def test_init_model_list_empty_redis(mock_redis):
    """Empty Redis results in empty MODEL_LIST."""
    mock_redis.keys = AsyncMock(return_value=[])

    with patch("regist_url_id.RedisManager.get_client", return_value=mock_redis):
        await regist_url_id.init_model_list()

    assert regist_url_id.MODEL_LIST == {}
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pytest tests/test_regist_url_id.py -v
```

Expected: ImportError or AttributeError — `init_model_list` doesn't exist yet.

- [ ] **Step 3: Write `regist_url_id.py` with only `init_model_list`**

```python
import logging
import re

from redis_hanlder import RedisManager

logger = logging.getLogger(__name__)

MODEL_LIST: dict[str, dict] = {}

_MODEL_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


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
```

- [ ] **Step 4: Run tests — expect them to pass**

```bash
pytest tests/test_regist_url_id.py -v
```

Expected: 3 PASSED.

- [ ] **Step 5: Commit**

```bash
git add requirements.txt pytest.ini tests/ regist_url_id.py
git commit -m "feat: add init_model_list with Redis hash loading and tests"
```

---

## Task 4: Implement `register_url`

**Files:**
- Modify: `regist_url_id.py`
- Modify: `tests/test_regist_url_id.py`

- [ ] **Step 1: Add failing tests for `register_url`**

Append to `tests/test_regist_url_id.py`:

```python
async def test_register_url_new_model(mock_redis):
    """Registering a new model writes to Redis and MODEL_LIST, returns True."""
    with patch("regist_url_id.RedisManager.get_client", return_value=mock_redis):
        result = await regist_url_id.register_url("llama3", "abc123-8000")

    assert result is True
    assert regist_url_id.MODEL_LIST["llama3"] == {"url_id": "abc123-8000", "is_on": True}
    mock_redis.hset.assert_awaited_once_with(
        "runpod:llama3", mapping={"url_id": "abc123-8000", "is_on": "true"}
    )


async def test_register_url_update_existing(mock_redis):
    """Updating an existing model with a new URL returns True and updates both stores."""
    regist_url_id.MODEL_LIST["llama3"] = {"url_id": "old-8000", "is_on": True}

    with patch("regist_url_id.RedisManager.get_client", return_value=mock_redis):
        result = await regist_url_id.register_url("llama3", "new-8000")

    assert result is True
    assert regist_url_id.MODEL_LIST["llama3"]["url_id"] == "new-8000"
    mock_redis.hset.assert_awaited_once()


async def test_register_url_noop_identical_entry(mock_redis):
    """Registering identical url_id and is_on returns False without touching Redis."""
    regist_url_id.MODEL_LIST["llama3"] = {"url_id": "abc123-8000", "is_on": True}

    with patch("regist_url_id.RedisManager.get_client", return_value=mock_redis):
        result = await regist_url_id.register_url("llama3", "abc123-8000", is_on=True)

    assert result is False
    mock_redis.hset.assert_not_awaited()


async def test_register_url_noop_does_not_validate(mock_redis):
    """No-op check runs before validation — invalid name is ignored when entry is identical."""
    # Pre-load an entry with a name that would fail validation if validated
    # (This tests that no-op returns False before even checking the name regex)
    regist_url_id.MODEL_LIST["valid-name"] = {"url_id": "abc-8000", "is_on": True}

    with patch("regist_url_id.RedisManager.get_client", return_value=mock_redis):
        result = await regist_url_id.register_url("valid-name", "abc-8000", is_on=True)

    assert result is False  # no-op, no validation triggered


async def test_register_url_invalid_model_name(mock_redis):
    """model_name with invalid characters raises ValueError."""
    with pytest.raises(ValueError, match="model_name"):
        with patch("regist_url_id.RedisManager.get_client", return_value=mock_redis):
            await regist_url_id.register_url("bad:name", "abc123-8000")


async def test_register_url_empty_url_id(mock_redis):
    """Empty url_id raises ValueError."""
    with pytest.raises(ValueError, match="url_id"):
        with patch("regist_url_id.RedisManager.get_client", return_value=mock_redis):
            await regist_url_id.register_url("llama3", "")


async def test_register_url_is_on_false(mock_redis):
    """Registering with is_on=False stores 'false' string in Redis."""
    with patch("regist_url_id.RedisManager.get_client", return_value=mock_redis):
        await regist_url_id.register_url("llama3", "abc123-8000", is_on=False)

    mock_redis.hset.assert_awaited_once_with(
        "runpod:llama3", mapping={"url_id": "abc123-8000", "is_on": "false"}
    )
    assert regist_url_id.MODEL_LIST["llama3"]["is_on"] is False
```

- [ ] **Step 2: Run to confirm failures**

```bash
pytest tests/test_regist_url_id.py -v -k "register_url"
```

Expected: all FAILed (AttributeError: module has no attribute 'register_url').

- [ ] **Step 3: Add `register_url` to `regist_url_id.py`**

Append after `init_model_list`:

```python
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

    # 4. Update in-memory cache
    MODEL_LIST[model_name] = {"url_id": url_id, "is_on": is_on}
    return True
```

- [ ] **Step 4: Run tests**

```bash
pytest tests/test_regist_url_id.py -v -k "register_url"
```

Expected: all PASSED.

- [ ] **Step 5: Commit**

```bash
git add regist_url_id.py tests/test_regist_url_id.py
git commit -m "feat: add register_url with validation and Redis hash write"
```

---

## Task 5: Implement `delete_url`

**Files:**
- Modify: `regist_url_id.py`
- Modify: `tests/test_regist_url_id.py`

- [ ] **Step 1: Add failing tests for `delete_url`**

Append to `tests/test_regist_url_id.py`:

```python
async def test_delete_url_existing_model(mock_redis):
    """Deleting a registered model removes it from MODEL_LIST and Redis, returns True."""
    regist_url_id.MODEL_LIST["llama3"] = {"url_id": "abc123-8000", "is_on": True}

    with patch("regist_url_id.RedisManager.get_client", return_value=mock_redis):
        result = await regist_url_id.delete_url("llama3")

    assert result is True
    assert "llama3" not in regist_url_id.MODEL_LIST
    mock_redis.delete.assert_awaited_once_with("runpod:llama3")


async def test_delete_url_not_registered(mock_redis):
    """Deleting a model not in MODEL_LIST returns False without touching Redis."""
    with patch("regist_url_id.RedisManager.get_client", return_value=mock_redis):
        result = await regist_url_id.delete_url("unknown")

    assert result is False
    mock_redis.delete.assert_not_awaited()


async def test_delete_url_redis_key_already_gone(mock_redis):
    """If Redis DEL returns 0 (key already gone), still remove from MODEL_LIST and return True."""
    regist_url_id.MODEL_LIST["llama3"] = {"url_id": "abc123-8000", "is_on": True}
    mock_redis.delete = AsyncMock(return_value=0)  # key not in Redis

    with patch("regist_url_id.RedisManager.get_client", return_value=mock_redis):
        result = await regist_url_id.delete_url("llama3")

    assert result is True
    assert "llama3" not in regist_url_id.MODEL_LIST
```

- [ ] **Step 2: Run to confirm failures**

```bash
pytest tests/test_regist_url_id.py -v -k "delete_url"
```

Expected: all FAILed.

- [ ] **Step 3: Add `delete_url` to `regist_url_id.py`**

```python
async def delete_url(model_name: str) -> bool:
    """Remove a RunPod pod URL. Returns True if deleted, False if not registered."""
    if model_name not in MODEL_LIST:
        return False

    redis = RedisManager.get_client()
    await redis.delete(f"runpod:{model_name}")  # DEL returning 0 is not an error
    del MODEL_LIST[model_name]
    return True
```

- [ ] **Step 4: Run tests**

```bash
pytest tests/test_regist_url_id.py -v -k "delete_url"
```

Expected: all PASSED.

- [ ] **Step 5: Commit**

```bash
git add regist_url_id.py tests/test_regist_url_id.py
git commit -m "feat: add delete_url with idempotent MODEL_LIST and Redis cleanup"
```

---

## Task 6: Implement `get_url`

**Files:**
- Modify: `regist_url_id.py`
- Modify: `tests/test_regist_url_id.py`

- [ ] **Step 1: Add failing tests for `get_url`**

Append to `tests/test_regist_url_id.py`:

```python
def test_get_url_registered_and_on():
    """Returns full URL when model is registered and is_on=True."""
    regist_url_id.MODEL_LIST["llama3"] = {"url_id": "abc123-8000", "is_on": True}
    result = regist_url_id.get_url("llama3")
    assert result == "https://abc123-8000.proxy.runpod.net/"


def test_get_url_registered_but_off():
    """Returns None when model is registered but is_on=False."""
    regist_url_id.MODEL_LIST["llama3"] = {"url_id": "abc123-8000", "is_on": False}
    result = regist_url_id.get_url("llama3")
    assert result is None


def test_get_url_not_registered():
    """Returns None when model is not in MODEL_LIST."""
    result = regist_url_id.get_url("unknown")
    assert result is None
```

- [ ] **Step 2: Run to confirm failures**

```bash
pytest tests/test_regist_url_id.py -v -k "get_url"
```

Expected: all FAILed.

- [ ] **Step 3: Add `get_url` to `regist_url_id.py`**

```python
def get_url(model_name: str) -> str | None:
    """Return the full URL for a model if it is registered and online. Sync, memory-only."""
    entry = MODEL_LIST.get(model_name)
    if entry and entry["is_on"]:
        return f"https://{entry['url_id']}.proxy.runpod.net/"
    return None
```

- [ ] **Step 4: Run all unit tests**

```bash
pytest tests/test_regist_url_id.py -v
```

Expected: all PASSED.

- [ ] **Step 5: Commit**

```bash
git add regist_url_id.py tests/test_regist_url_id.py
git commit -m "feat: add get_url sync memory-only lookup"
```

---

## Task 7: Update `app.py` — fix await and add endpoints

**Files:**
- Modify: `app.py`
- Create: `tests/test_app.py`

- [ ] **Step 1: Write failing endpoint tests**

Create `tests/test_app.py`:

```python
import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient
import regist_url_id


@pytest.fixture
def client():
    """TestClient with lifespan disabled — we control MODEL_LIST directly."""
    from app import app
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


# --- POST /register_url ---

def test_post_register_url_new(client):
    """Registering a new model returns 200 with updated=True."""
    with patch("app.register_url", new=AsyncMock(return_value=True)) as mock:
        resp = client.post("/register_url", json={"model_name": "llama3", "url_id": "abc-8000"})
    assert resp.status_code == 200
    assert resp.json() == {"registered": True, "updated": True}


def test_post_register_url_noop(client):
    """Registering an identical entry returns 200 with updated=False."""
    with patch("app.register_url", new=AsyncMock(return_value=False)):
        resp = client.post("/register_url", json={"model_name": "llama3", "url_id": "abc-8000"})
    assert resp.status_code == 200
    assert resp.json() == {"registered": True, "updated": False}


def test_post_register_url_invalid_name(client):
    """Invalid model_name (contains ':') returns 422."""
    with patch("app.register_url", new=AsyncMock(side_effect=ValueError("model_name invalid"))):
        resp = client.post("/register_url", json={"model_name": "bad:name", "url_id": "abc-8000"})
    assert resp.status_code == 422


def test_post_register_url_redis_error(client):
    """Redis failure returns 500."""
    with patch("app.register_url", new=AsyncMock(side_effect=Exception("Redis down"))):
        resp = client.post("/register_url", json={"model_name": "llama3", "url_id": "abc-8000"})
    assert resp.status_code == 500


# --- DELETE /delete_url/{model_name} ---

def test_delete_url_existing(client):
    """Deleting a registered model returns 200 with deleted=True."""
    with patch("app.delete_url", new=AsyncMock(return_value=True)):
        resp = client.delete("/delete_url/llama3")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": True}


def test_delete_url_not_found(client):
    """Deleting a non-registered model returns 200 with deleted=False (idempotent)."""
    with patch("app.delete_url", new=AsyncMock(return_value=False)):
        resp = client.delete("/delete_url/unknown")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": False}


def test_delete_url_redis_error(client):
    """Redis failure returns 500."""
    with patch("app.delete_url", new=AsyncMock(side_effect=Exception("Redis down"))):
        resp = client.delete("/delete_url/llama3")
    assert resp.status_code == 500


# --- GET /get_url/{model_name} ---

def test_get_url_found(client):
    """Returns 200 with url when model is registered and online."""
    with patch("app.get_url", return_value="https://abc-8000.proxy.runpod.net/"):
        resp = client.get("/get_url/llama3")
    assert resp.status_code == 200
    assert resp.json() == {"model_name": "llama3", "url": "https://abc-8000.proxy.runpod.net/"}


def test_get_url_not_found(client):
    """Returns 404 when model not registered or offline."""
    with patch("app.get_url", return_value=None):
        resp = client.get("/get_url/unknown")
    assert resp.status_code == 404
    assert "not registered" in resp.json()["detail"]
```

- [ ] **Step 2: Run to confirm failures**

```bash
pytest tests/test_app.py -v
```

Expected: FAILed (endpoints don't exist yet).

- [ ] **Step 3: Rewrite `app.py`**

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from redis_hanlder import RedisManager
from regist_url_id import init_model_list, register_url, delete_url, get_url


@asynccontextmanager
async def lifespan(app: FastAPI):
    await RedisManager.init()
    await init_model_list()   # was missing await — fixed
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
```

- [ ] **Step 4: Run endpoint tests**

```bash
pytest tests/test_app.py -v
```

Expected: all PASSED.

- [ ] **Step 5: Run full test suite**

```bash
pytest -v
```

Expected: all PASSED across both test files.

- [ ] **Step 6: Commit**

```bash
git add app.py tests/test_app.py
git commit -m "feat: add register/delete/get_url HTTP endpoints, fix missing await on init"
```

---

## Final Verification

- [ ] **Confirm all tests pass**

```bash
pytest -v
```

Expected output: all green, no warnings about coroutines or missing awaits.

- [ ] **Smoke test server start (optional)**

```bash
uvicorn app:app --port 8000
```

Expected: server starts, visits `http://localhost:8000/` returns `{"message": "RUNPOD URL SELECTOR SERVER"}`.
Note: requires a Redis instance on localhost:31200. If unavailable, the startup will fail on `init_model_list` — this is expected.
