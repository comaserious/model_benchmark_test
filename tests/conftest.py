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
