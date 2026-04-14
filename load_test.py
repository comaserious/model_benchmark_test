"""
단계별 동시 부하 테스트 실행 로직

각 step에서 N명을 asyncio.to_thread로 동시에 benchmark_streaming 실행.
결과: load_test_logs/{gpu}/{model}/{timestamp}.json
"""
import asyncio
import json
import os
from datetime import datetime

from benchmark import benchmark_streaming, _sanitize_name

LOAD_TEST_DIR = "load_test_logs"

PROMPTS = [
    "Explain the difference between TCP and UDP protocols, including when to use each one.",
    "Write a Python function that finds all prime numbers up to N using the Sieve of Eratosthenes.",
    "Summarize the key principles of object-oriented programming with real-world analogies.",
    "Describe how a neural network learns through backpropagation, step by step.",
    "Write a FastAPI endpoint for user registration with input validation and error handling.",
]


def _get_json_path(gpu: str, model: str, timestamp: str) -> str:
    model_dir = os.path.join(LOAD_TEST_DIR, _sanitize_name(gpu), _sanitize_name(model))
    os.makedirs(model_dir, exist_ok=True)
    return os.path.join(model_dir, f"{timestamp}.json")


def _aggregate(results: list[dict]) -> dict:
    successful = [r for r in results if r.get("success")]
    if not successful:
        return {
            "avg_ttft": 0, "p95_ttft": 0, "max_ttft": 0,
            "avg_tps": 0, "min_tps": 0,
            "avg_e2e": 0, "p95_e2e": 0, "max_e2e": 0,
            "successful": 0, "total": len(results),
        }

    ttfts = sorted(r["ttft_s"] for r in successful)
    tpss = [r["tps"] for r in successful]
    e2es = sorted(r["e2e_time_s"] for r in successful)

    def p95(lst: list) -> float:
        idx = min(int(len(lst) * 0.95), len(lst) - 1)
        return lst[idx]

    return {
        "avg_ttft": round(sum(ttfts) / len(ttfts), 3),
        "p95_ttft": round(p95(ttfts), 3),
        "max_ttft": round(max(ttfts), 3),
        "avg_tps": round(sum(tpss) / len(tpss), 2),
        "min_tps": round(min(tpss), 2),
        "avg_e2e": round(sum(e2es) / len(e2es), 3),
        "p95_e2e": round(p95(e2es), 3),
        "max_e2e": round(max(e2es), 3),
        "successful": len(successful),
        "total": len(results),
    }


async def _run_user_into_queue(
    queue: asyncio.Queue,
    user_id: int,
    url: str,
    model: str,
    prompt: str,
    max_tokens: int,
    headers: dict | None,
) -> None:
    try:
        result = await asyncio.to_thread(
            benchmark_streaming, url, model, prompt, max_tokens, headers
        )
    except Exception:
        result = None

    user_result = {
        "user_id": user_id,
        "success": result is not None,
        **(result if result else {"ttft_s": 0.0, "tps": 0.0, "e2e_time_s": 0.0, "total_tokens": 0}),
    }
    await queue.put(user_result)


async def run_load_test_stream(
    url: str,
    model: str,
    gpu: str,
    url_id: str,
    steps: list[int],
    rounds: int = 1,
    max_tokens: int = 256,
    headers: dict | None = None,
):
    """Async generator: 각 step/user 완료마다 SSE 이벤트 dict를 yield."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    json_path = _get_json_path(gpu, model, timestamp)

    meta = {
        "gpu": gpu,
        "model": model,
        "url_id": url_id,
        "date": datetime.now().isoformat(),
        "steps": steps,
        "rounds": rounds,
        "max_tokens": max_tokens,
    }

    all_steps = []
    total_steps = len(steps)

    yield {
        "event": "test_start",
        "gpu": gpu,
        "model": model,
        "steps": steps,
        "total_steps": total_steps,
    }

    for step_idx, n_users in enumerate(steps):
        queue: asyncio.Queue = asyncio.Queue()

        yield {
            "event": "step_start",
            "step": step_idx + 1,
            "concurrent_users": n_users,
            "total_steps": total_steps,
        }

        tasks = [
            asyncio.create_task(
                _run_user_into_queue(
                    queue, uid,
                    url, model,
                    PROMPTS[(uid - 1) % len(PROMPTS)],
                    max_tokens, headers,
                )
            )
            for uid in range(1, n_users + 1)
        ]

        per_user_results = []
        for _ in range(n_users):
            result = await queue.get()
            per_user_results.append(result)
            yield {"event": "user_done", "step": step_idx + 1, **result}

        aggregate = _aggregate(per_user_results)
        step_data = {
            "concurrent_users": n_users,
            "per_user": per_user_results,
            "aggregate": aggregate,
        }
        all_steps.append(step_data)

        yield {
            "event": "step_done",
            "step": step_idx + 1,
            "concurrent_users": n_users,
            "aggregate": aggregate,
        }

    log_data = {"meta": meta, "steps": all_steps}
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(log_data, f, ensure_ascii=False, indent=2)

    yield {
        "event": "test_done",
        "json_path": json_path,
        "meta": meta,
        "steps": all_steps,
    }


def load_all_load_test_logs() -> list[dict]:
    """load_test_logs 디렉토리의 모든 JSON을 최신순으로 반환."""
    results = []
    if not os.path.isdir(LOAD_TEST_DIR):
        return results
    for root, _dirs, files in os.walk(LOAD_TEST_DIR):
        for fname in files:
            if not fname.endswith(".json"):
                continue
            fpath = os.path.join(root, fname)
            with open(fpath, encoding="utf-8") as f:
                try:
                    data = json.load(f)
                    results.append(data)
                except json.JSONDecodeError:
                    continue
    return sorted(results, key=lambda x: x.get("meta", {}).get("date", ""), reverse=True)
