"""
동시 사용자 부하 테스트 (Locust)

설치:
  pip install locust

실행 방법:
  # 웹 UI (http://localhost:8089 에서 사용자 수 조절)
  locust -f locustfile.py --host http://localhost:8000

  # 헤드리스 (5명 동시, 1명/초 증가, 3분 실행)
  locust -f locustfile.py --host http://localhost:8000 --headless -u 5 -r 1 --run-time 3m

  # 10명 동시
  locust -f locustfile.py --host http://localhost:8000 --headless -u 10 -r 2 --run-time 3m

환경변수로 테스트 대상 설정:
  # RunPod 모드
  TEST_MODE=runpod TEST_URL_ID=abc123xyz TEST_GPU=A100 locust ...

  # API 모드 (OpenAI 등)
  TEST_MODE=api TEST_API_BASE=https://api.openai.com TEST_API_KEY=sk-xxx TEST_API_MODEL=gpt-4o locust ...
"""

import json
import os

from locust import HttpUser, between, events, task

# ── 테스트 설정 (환경변수로 override 가능) ──────────────────────────────────
MODE = os.getenv("TEST_MODE", "runpod")          # "runpod" | "api"

# RunPod 모드
URL_ID      = os.getenv("TEST_URL_ID", "your-pod-id")
GPU         = os.getenv("TEST_GPU", "A100")

# API 모드
API_BASE     = os.getenv("TEST_API_BASE", "https://api.openai.com")
API_KEY      = os.getenv("TEST_API_KEY", "")
API_MODEL    = os.getenv("TEST_API_MODEL", "gpt-4o-mini")
API_PROVIDER = os.getenv("TEST_API_PROVIDER", "OpenAI")

# 공통
ROUNDS     = int(os.getenv("TEST_ROUNDS", "1"))       # 라운드 수 (동시 테스트엔 1 권장)
MAX_TOKENS = int(os.getenv("TEST_MAX_TOKENS", "128")) # 토큰 수 적을수록 빠름
# ────────────────────────────────────────────────────────────────────────────


def _build_body() -> dict:
    if MODE == "api":
        return {
            "mode": "api",
            "api_base": API_BASE,
            "api_key": API_KEY,
            "model": API_MODEL,
            "provider": API_PROVIDER,
            "rounds": ROUNDS,
            "max_tokens": MAX_TOKENS,
        }
    return {
        "mode": "runpod",
        "url_id": URL_ID,
        "gpu": GPU,
        "rounds": ROUNDS,
        "max_tokens": MAX_TOKENS,
    }


class BenchmarkUser(HttpUser):
    """
    각 사용자가 /benchmark SSE 엔드포인트를 호출하는 시나리오.
    wait_time: 한 요청이 끝난 뒤 다음 요청까지 대기 시간 (초)
    """
    wait_time = between(1, 3)

    @task(10)
    def run_benchmark(self):
        """LLM 벤치마크 요청 — SSE 스트림을 끝까지 소비"""
        with self.client.post(
            "/benchmark",
            json=_build_body(),
            stream=True,
            catch_response=True,
            timeout=300,
            name="/benchmark",
        ) as res:
            if res.status_code != 200:
                res.failure(f"HTTP {res.status_code}")
                return

            done_received = False
            ttft_values = []
            tps_values = []

            for raw in res.iter_lines():
                if not raw:
                    continue
                line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
                if not line.startswith("data: "):
                    continue
                try:
                    data = json.loads(line[6:])
                except json.JSONDecodeError:
                    continue

                event = data.get("event")

                if event == "error":
                    res.failure(data.get("detail", "unknown error"))
                    return

                if event == "round" and data.get("success"):
                    ttft_values.append(data.get("ttft_s", 0))
                    tps_values.append(data.get("tps", 0))

                if event == "done":
                    done_received = True
                    summary = data.get("summary")
                    if summary:
                        # 커스텀 통계를 locust 이벤트로 기록
                        events.request.fire(
                            request_type="LLM",
                            name="avg_ttft_s",
                            response_time=summary["avg_ttft_s"] * 1000,  # ms
                            response_length=summary["total_tokens"],
                            exception=None,
                            context={},
                        )
                        events.request.fire(
                            request_type="LLM",
                            name="avg_tps",
                            response_time=summary["avg_tps"],
                            response_length=summary["total_tokens"],
                            exception=None,
                            context={},
                        )
                        res.success()
                    else:
                        res.failure("No successful rounds")

            if not done_received:
                res.failure("Stream ended without 'done' event")

    @task(1)
    def health_check(self):
        """서버 응답 상태 확인 (가벼운 요청)"""
        self.client.get("/", name="/health")
