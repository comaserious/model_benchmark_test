# Load Test UI & Budget Recommendation — Design Spec

**Date:** 2026-04-14  
**Goal:** RunPod에서 여러 GPU를 단계별 부하 테스트하여, 실제 서버 구축 시 GPU 모델과 수량을 추천하는 시스템

---

## 1. 배경 및 목표

현재 `locustfile.py`는 CLI로만 실행 가능하고, LLM 전용 지표(TTFT, TPS)를 직접 추적하기 어렵다. 목표는:

1. 웹 UI에서 단계별 동시 사용자 부하 테스트를 실행
2. 사용자별 TTFT / TPS / E2E Time 수집 및 저장
3. 수집 데이터를 바탕으로 GPU 구매 추천 산출

---

## 2. 측정 지표

| 지표 | 설명 | 활용 |
|------|------|------|
| **TTFT (s)** | 첫 토큰까지 시간 | 응답성 SLA 판단 |
| **TPS** | 초당 토큰 수 | 처리량 SLA 판단 |
| **E2E Time (s)** | 요청 전송 ~ 마지막 토큰 수신 (사용자 체감 대기시간) | 사용자 경험 SLA |
| **Total Tokens** | 생성된 토큰 수 | 처리량 보정 |

`E2E Time`은 기존 `total_time_s`를 rename하여 명확히 표현한다.

---

## 3. 아키텍처

```
[loadtest.html] ──POST /load-test──▶ FastAPI
                                         │
                              asyncio.gather() × N users
                                         │
                              benchmark_streaming() × N (병렬)
                                         │
                              SSE 이벤트 스트리밍 ──▶ 프론트엔드
                                         │
                              load_test_logs/{gpu}/{model}/{timestamp}.json 저장

[loadtest.html] ──GET /load-test/logs──▶ 저장된 결과 목록
```

---

## 4. 백엔드

### 4-1. 신규 Pydantic 모델

```python
class LoadTestConfig(BaseModel):
    mode: str = "runpod"          # "runpod" | "api"
    # RunPod
    url_id: str | None = None
    gpu: str | None = None
    # API
    api_base: str | None = None
    api_key: str | None = None
    model: str | None = None
    provider: str | None = None
    # Common
    rounds: int = 1
    max_tokens: int = 256
    # Step 설정
    steps: list[int]              # e.g. [1, 3, 5, 10, 20]
```

### 4-2. 신규 엔드포인트

**`POST /load-test`** — SSE StreamingResponse

각 step에서:
1. `asyncio.gather()`로 N개의 `benchmark_streaming()` 동시 실행
   - `benchmark_streaming()`은 `requests` 기반 동기 함수이므로 `asyncio.to_thread()`로 스레드 풀에서 실행
2. 완료 순서대로 SSE 이벤트 yield
3. step 완료 후 aggregate 계산 및 JSON 저장

SSE 이벤트 스키마:
```
{"event": "step_start", "step": 1, "concurrent_users": 3, "total_steps": 5}
{"event": "user_done", "step": 1, "user_id": 2, "ttft_s": 1.4, "tps": 38.1, "e2e_time_s": 4.2, "total_tokens": 131}
{"event": "step_done", "step": 1, "concurrent_users": 3, "aggregate": {...}}
{"event": "test_done", "steps": [...]}
{"event": "error", "detail": "..."}
```

**`GET /load-test/logs`** — 저장된 부하 테스트 결과 목록 반환

### 4-3. 저장 포맷

파일 경로: `load_test_logs/{gpu}/{model}/{timestamp}.json`

```json
{
  "meta": {
    "gpu": "RTX5090",
    "model": "Qwen/Qwen3-8B",
    "url_id": "abc123",
    "date": "2026-04-14T10:30:00",
    "steps": [1, 3, 5, 10, 20],
    "rounds": 1,
    "max_tokens": 256
  },
  "steps": [
    {
      "concurrent_users": 3,
      "per_user": [
        {"user_id": 1, "ttft_s": 0.8, "tps": 45.2, "e2e_time_s": 3.1, "total_tokens": 128},
        {"user_id": 2, "ttft_s": 1.4, "tps": 38.1, "e2e_time_s": 4.2, "total_tokens": 131},
        {"user_id": 3, "ttft_s": 2.1, "tps": 31.5, "e2e_time_s": 5.8, "total_tokens": 125}
      ],
      "aggregate": {
        "avg_ttft": 1.43, "p95_ttft": 2.0, "max_ttft": 2.1,
        "avg_tps": 38.3, "min_tps": 31.5,
        "avg_e2e": 4.37, "p95_e2e": 5.5, "max_e2e": 5.8
      }
    }
  ]
}
```

---

## 5. 프론트엔드 — `front/loadtest.html`

### 패널 1: 설정

- RunPod / API 모드 토글 (benchmark.html과 동일 UX)
- Step 프리셋 버튼:
  - `Quick [1→5→10]`
  - `Standard [1→3→5→10→20]`
  - `Deep [1→5→10→20→50]`
  - `Custom` → 시작 / 끝 / 증가단위 입력
- Rounds per user (기본 1), Max tokens (기본 256)
- **Run Load Test** 버튼

### 패널 2: 실시간 진행 상황

- Step 진행 표시: `Step 2 / 5 — 3명 동시 실행 중`
- 사용자별 상태 카드 (실행 중 → 완료 시 지표 표시):
  ```
  User 1  ✓  TTFT 0.8s | TPS 45.2 | E2E 3.1s
  User 2  ✓  TTFT 1.4s | TPS 38.1 | E2E 4.2s
  User 3  ⟳  실행 중...
  ```
- Step 완료 요약 배지: `avg TTFT 1.4s / avg TPS 38.3 / avg E2E 4.4s`

### 패널 3: 결과 차트 (전체 완료 후)

차트 3개 (Canvas 기반, Chart.js):
1. **동시 사용자 수 → avg TTFT + p95 TTFT** (음영으로 범위 표시)
2. **동시 사용자 수 → avg E2E + p95 E2E**
3. **동시 사용자 수 → avg TPS**

Step별 상세 테이블:

| Users | avg TTFT | p95 TTFT | max TTFT | avg TPS | avg E2E | max E2E |
|-------|----------|----------|----------|---------|---------|---------|

### 패널 4: 예산 추천 계산기

**입력:**
- 목표 동시 사용자 수
- 허용 최대 TTFT (초)
- 허용 최대 E2E Time (초)
- 모델 구성: 단일 모델 선택 or 멀티 모델 (모델 조합 체크박스)

**계산 로직:**
1. 수집 데이터에서 TTFT 또는 E2E가 임계값을 초과하는 첫 step 탐색
2. GPU 1개당 최대 처리 가능 사용자 수 = 임계값 직전 step의 concurrent_users
3. 필요 GPU 수 = ceil(목표 사용자 ÷ GPU당 최대)
4. 멀티모델: 각 모델별 독립 GPU 구성, 수량 합산

**출력 테이블:**

| 구성 | GPU | 수량 | 처리 가능 사용자 | avg TTFT | avg E2E | 비고 |
|------|-----|------|-----------------|----------|---------|------|
| 단일 모델 (gpt-oss) | RTX5090 | 2개 | 10명 | 1.8s | 4.2s | 데이터 기반 |
| 멀티 모델 (gpt-oss + Qwen) | RTX5090 | 4개 | 10명 | 2.1s | 5.1s | 각 모델 독립 GPU |

데이터가 없는 GPU/모델 조합은 "데이터 없음" 표시.

---

## 6. 기존 파일 변경

- `benchmark.py`: `total_time_s` → `e2e_time_s` rename (기존 CSV 하위 호환 유지)
- `app.py`: `/load-test`, `/load-test/logs` 엔드포인트 추가
- `front/benchmark.html`: History 섹션에 Load Test 결과 링크 추가

---

## 7. 범위 외 (이번 구현에서 제외)

- 실시간 멀티모델 동시 실행 테스트 (동일 GPU에서 두 모델 동시 로드)
- RunPod 시간당 비용 계산
- Locust 연동 유지 (locustfile.py는 별도로 존재하지만 이번 구현과 무관)
