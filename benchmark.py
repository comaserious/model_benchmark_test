"""
vLLM Pod 성능 벤치마크
- TTFT (Time To First Token): 첫 토큰 생성 시간
- TPS (Tokens Per Second): 초당 토큰 생성량
- Total Time: 전체 응답 시간

사용법:
  python benchmark.py --url https://your-pod-url:8000 --model google/gemma-3-12b-it
  python benchmark.py --url https://your-pod-url:8000 --model Qwen/Qwen3-8B-FP8 --rounds 5
"""

import argparse
import csv
import json
import os
import time
from datetime import datetime

import requests

BENCHMARK_DIR = "benchmark_logs"
CSV_FIELDS = [
    "timestamp", "url_id", "url", "gpu", "model", "round", "prompt",
    "ttft_s", "tps", "total_tokens", "total_time_s", "type",
]


def benchmark_streaming(url: str, model: str, prompt: str, max_tokens: int = 256, headers: dict | None = None):
    """스트리밍 응답으로 TTFT, TPS 측정. url은 base URL (e.g. https://api.openai.com/)"""
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "stream": True,
    }

    if "Qwen" in model:
        payload['chat_template_kwargs'] = {"enable_thinking" : False}

    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)

    start_time = time.perf_counter()
    first_token_time = None
    token_count = 0
    token_times = []

    endpoint = f"{url.rstrip('/')}/v1/chat/completions"
    response = requests.post(
        endpoint,
        json=payload,
        headers=req_headers,
        stream=True,
        timeout=300,
    )
    response.raise_for_status()

    for line in response.iter_lines():
        if not line:
            continue
        line = line.decode("utf-8")
        if not line.startswith("data: "):
            continue
        data = line[6:]
        if data.strip() == "[DONE]":
            break

        try:
            chunk = json.loads(data)
            delta = chunk.get("choices", [{}])[0].get("delta", {})
            content = delta.get("content", "")
            if content:
                now = time.perf_counter()
                if first_token_time is None:
                    first_token_time = now
                token_count += 1
                token_times.append(now)
        except json.JSONDecodeError:
            continue

    end_time = time.perf_counter()

    if first_token_time is None:
        return None

    ttft = first_token_time - start_time
    total_time = end_time - start_time

    if len(token_times) > 2:
        gen_duration = token_times[-1] - token_times[0]
        tps = (len(token_times) - 1) / gen_duration if gen_duration > 0.01 else 0
    else:
        tps = 0

    return {
        "ttft_s": round(ttft, 3),
        "tps": round(tps, 2),
        "total_tokens": token_count,
        "e2e_time_s": round(total_time, 3),
    }


def _sanitize_name(name: str) -> str:
    """파일/디렉토리명에 안전한 문자열로 변환. 'org/model' -> 'org--model'"""
    return name.replace("/", "--").replace("\\", "--").replace(":", "-")


def _get_csv_path(gpu: str, model: str, url_id: str) -> str:
    """benchmark_logs/{gpu}/{model}/{url_id}.csv 경로 반환."""
    model_dir = os.path.join(BENCHMARK_DIR, _sanitize_name(gpu), _sanitize_name(model))
    os.makedirs(model_dir, exist_ok=True)
    return os.path.join(model_dir, f"{_sanitize_name(url_id)}.csv")


def _append_csv(csv_path: str, row: dict):
    """CSV 파일에 결과 한 줄 추가. 파일이 없으면 헤더 포함 생성."""
    write_header = not os.path.exists(csv_path)
    with open(csv_path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if write_header:
            writer.writeheader()
        writer.writerow(row)


def run_benchmark_stream(
    url: str, model: str, gpu: str, url_id: str,
    rounds: int = 3, max_tokens: int = 256,
    headers: dict | None = None,
):
    """제너레이터: 라운드마다 SSE 이벤트용 dict를 yield한다."""
    prompts = [
        "Explain the difference between TCP and UDP protocols, including when to use each one.",
        "Write a Python function that finds all prime numbers up to N using the Sieve of Eratosthenes. Include docstring and examples.",
        "Summarize the key principles of object-oriented programming and provide a real-world analogy for each concept.",
        "Describe how a neural network learns through backpropagation. Explain it step by step.",
        "Write a REST API endpoint in FastAPI that handles user registration with input validation and error handling.",
    ]

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    csv_path = _get_csv_path(gpu, model, url_id)
    is_new_pod = not os.path.exists(csv_path)

    # start event
    yield {
        "event": "start",
        "gpu": gpu,
        "model": model,
        "url": url,
        "url_id": url_id,
        "is_new_pod": is_new_pod,
        "total_rounds": rounds,
    }

    all_results = []

    for r in range(rounds):
        prompt = prompts[r % len(prompts)]

        # progress event (round 시작)
        yield {
            "event": "progress",
            "current": r + 1,
            "total": rounds,
            "status": f"Running round {r + 1}/{rounds}...",
        }

        result = benchmark_streaming(url, model, prompt, max_tokens, headers=headers)
        if result is None:
            yield {
                "event": "round",
                "current": r + 1,
                "total": rounds,
                "success": False,
            }
            continue

        all_results.append(result)

        _append_csv(csv_path, {
            "timestamp": now,
            "url_id": url_id,
            "url": url,
            "gpu": gpu,
            "model": model,
            "round": r + 1,
            "prompt": prompt,
            "type": "round",
            "ttft_s": result["ttft_s"],
            "tps": result["tps"],
            "total_tokens": result["total_tokens"],
            "total_time_s": result["e2e_time_s"],
        })

        # round 완료 event
        yield {
            "event": "round",
            "current": r + 1,
            "total": rounds,
            "success": True,
            "ttft_s": result["ttft_s"],
            "tps": result["tps"],
            "total_tokens": result["total_tokens"],
            "e2e_time_s": result["e2e_time_s"],
        }

    # done event
    summary = None
    if all_results:
        avg_ttft = sum(r["ttft_s"] for r in all_results) / len(all_results)
        avg_tps = sum(r["tps"] for r in all_results) / len(all_results)
        avg_total = sum(r["e2e_time_s"] for r in all_results) / len(all_results)

        _append_csv(csv_path, {
            "timestamp": now,
            "url_id": url_id,
            "url": url,
            "gpu": gpu,
            "model": model,
            "round": "avg",
            "prompt": "",
            "ttft_s": round(avg_ttft, 3),
            "tps": round(avg_tps, 2),
            "total_tokens": sum(r["total_tokens"] for r in all_results),
            "total_time_s": round(avg_total, 3),
            "type": "summary",
        })

        summary = {
            "avg_ttft_s": round(avg_ttft, 3),
            "avg_tps": round(avg_tps, 2),
            "avg_e2e_time_s": round(avg_total, 3),
            "total_tokens": sum(r["total_tokens"] for r in all_results),
            "successful_rounds": len(all_results),
        }

    yield {
        "event": "done",
        "gpu": gpu,
        "model": model,
        "url": url,
        "url_id": url_id,
        "is_new_pod": is_new_pod,
        "rounds": all_results,
        "summary": summary,
        "csv_path": csv_path,
    }


def load_all_logs() -> list[dict]:
    """benchmark_logs 디렉토리의 모든 CSV를 읽어 리스트로 반환."""
    rows = []
    if not os.path.isdir(BENCHMARK_DIR):
        return rows
    for root, _dirs, files in os.walk(BENCHMARK_DIR):
        for fname in files:
            if not fname.endswith(".csv"):
                continue
            fpath = os.path.join(root, fname)
            with open(fpath, newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    for key in ("ttft_s", "tps", "total_time_s"):
                        if row.get(key):
                            row[key] = float(row[key])
                    if row.get("total_tokens"):
                        row["total_tokens"] = int(row["total_tokens"])
                    row["e2e_time_s"] = float(row["total_time_s"]) if row.get("total_time_s") else 0.0
                    rows.append(row)
    return rows


# if __name__ == "__main__":
#     parser = argparse.ArgumentParser(description="vLLM Pod Benchmark")
#     parser.add_argument("--url", required=True, help="Pod URL (e.g. https://xxx-8000.proxy.runpod.net)")
#     parser.add_argument("--model", required=True, help="Model name")
#     parser.add_argument("--rounds", type=int, default=3, help="Number of rounds")
#     parser.add_argument("--max-tokens", type=int, default=256, help="Max tokens per response")
#     args = parser.parse_args()

#     run_benchmark(args.url, args.model, args.rounds, args.max_tokens)
