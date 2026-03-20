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


def benchmark_streaming(url: str, model: str, prompt: str, max_tokens: int = 256):
    """스트리밍 응답으로 TTFT, TPS 측정"""
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "stream": True,
    }

    start_time = time.perf_counter()
    first_token_time = None
    token_count = 0
    token_times = []

    response = requests.post(
        f"{url}/v1/chat/completions",
        json=payload,
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
        "total_time_s": round(total_time, 3),
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


def run_benchmark(url: str, model: str, gpu: str, url_id: str, rounds: int = 3, max_tokens: int = 256):
    prompts = [
        "What is 1+1?",
        "Explain quantum computing in simple terms.",
        "Write a short Python function that sorts a list.",
    ]

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    csv_path = _get_csv_path(gpu, model, url_id)
    is_new_pod = not os.path.exists(csv_path)

    print(f"\n{'='*60}")
    print(f"  vLLM Benchmark")
    print(f"  URL: {url}")
    print(f"  GPU: {gpu}")
    print(f"  Model: {model}")
    print(f"  Pod: {url_id} ({'NEW' if is_new_pod else 'EXISTING'})")
    print(f"  Rounds: {rounds}, Max Tokens: {max_tokens}")
    print(f"{'='*60}\n")

    all_results = []

    for r in range(rounds):
        prompt = prompts[r % len(prompts)]
        print(f"[Round {r+1}/{rounds}] \"{prompt[:50]}...\"")

        result = benchmark_streaming(url, model, prompt, max_tokens)
        if result is None:
            print(f"  -> Failed (no tokens received)\n")
            continue

        all_results.append(result)
        print(f"  TTFT:    {result['ttft_s']:.3f}s")
        print(f"  TPS:     {result['tps']:.2f} tokens/s")
        print(f"  Tokens:  {result['total_tokens']}")
        print(f"  Total:   {result['total_time_s']:.3f}s\n")

        _append_csv(csv_path, {
            "timestamp": now,
            "url_id": url_id,
            "url": url,
            "gpu": gpu,
            "model": model,
            "round": r + 1,
            "prompt": prompt,
            "type": "round",
            **result,
        })

    if all_results:
        avg_ttft = sum(r["ttft_s"] for r in all_results) / len(all_results)
        avg_tps = sum(r["tps"] for r in all_results) / len(all_results)
        avg_total = sum(r["total_time_s"] for r in all_results) / len(all_results)

        print(f"{'='*60}")
        print(f"  Summary ({len(all_results)} rounds)")
        print(f"{'='*60}")
        print(f"  Avg TTFT:    {avg_ttft:.3f}s")
        print(f"  Avg TPS:     {avg_tps:.2f} tokens/s")
        print(f"  Avg Total:   {avg_total:.3f}s")
        print(f"{'='*60}\n")

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

        print(f"  Results saved to {csv_path}")

        return {
            "gpu": gpu,
            "model": model,
            "url": url,
            "url_id": url_id,
            "is_new_pod": is_new_pod,
            "rounds": all_results,
            "summary": {
                "avg_ttft_s": round(avg_ttft, 3),
                "avg_tps": round(avg_tps, 2),
                "avg_total_time_s": round(avg_total, 3),
                "total_tokens": sum(r["total_tokens"] for r in all_results),
                "successful_rounds": len(all_results),
            },
            "csv_path": csv_path,
        }

    return {
        "gpu": gpu,
        "model": model,
        "url": url,
        "url_id": url_id,
        "is_new_pod": is_new_pod,
        "rounds": [],
        "summary": None,
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
