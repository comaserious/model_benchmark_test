# GPU 구성별 최적 모델 조합 가이드

> 작성일: 2026-04-15  
> 기준: A100 80GB / vLLM / max_tokens=8192 / SLA TTFT≤3s · E2E≤30s

---

## 핵심 전제 — KV Cache와 VRAM의 관계

```
VRAM 80GB × gpu_memory_utilization 0.90 = 유효 72GB

72GB = 모델 가중치 + KV Cache

KV Cache 부족 시 발생하는 문제:
  ├── max_tokens 상한 강제 하향
  ├── 동시 요청 큐잉 → TTFT 급등
  └── OOM으로 요청 강제 종료
```

**모델당 KV Cache 최소 권장량**

| 동시 사용자 목표 | 필요 KV Cache |
|---------------|-------------|
| 5~10 유저     | 10 GB       |
| 10~20 유저    | 15~20 GB    |
| 20~50 유저    | 25~35 GB    |

---

## 모델별 가중치 메모리 참조표

| 모델 | BF16 | FP8 | INT8 | AWQ (W4A16) |
|------|------|-----|------|-------------|
| Qwen3-8B | 16 GB | — | 8 GB | 4 GB |
| gemma-4-E4B-it | 8 GB | — | 4 GB | 2 GB |
| gemma-3-12b-it | 24 GB | — | 12 GB | 6 GB |
| gpt-oss-20b | 40 GB | 20 GB | 20 GB | 10 GB |
| EXAONE-4.0-32B | 64 GB | 32 GB | 32 GB | **18 GB** |
| gemma-4-26B-A4B | 52 GB | 26 GB | 26 GB | **13 GB** |
| gemma-4-31B | 62 GB | 31 GB | 31 GB | 15 GB |
| DeepSeek-R1-Qwen-32B | 64 GB | 32 GB | 32 GB | 16 GB |
| DeepSeek-R1-Llama-70B | — | — | — | **35 GB** (W4A16 출시) |

> MoE 모델(gpt-oss-20b, gemma-4-26B-A4B)은 활성 파라미터는 적지만  
> **모든 expert 가중치를 VRAM에 상주**시켜야 하므로 total params 기준으로 계산

---

## A100 × 1 (단일 GPU / 유효 72GB)

### 구성 1 — 한국어 서비스 최적 ★ 추천

```
┌─────────────────────────────────────────────────────┐
│  A100 80GB                                          │
│                                                     │
│  EXAONE-4.0-32B-AWQ  ████████████  18 GB (가중치)   │
│  Qwen3-8B BF16       ████████      16 GB (가중치)   │
│  KV Cache 잔여        ████████████████████  38 GB   │
│                       └── 모델당 19 GB              │
└─────────────────────────────────────────────────────┘
```

| 항목 | 값 |
|------|---|
| 가중치 합계 | 34 GB |
| KV Cache | 38 GB (모델당 19 GB) |
| 동시 사용자 | 각 모델 15~20 유저 |
| 실측 TTFT @50u | EXAONE 1.87s / Qwen 0.89s |
| 실측 TPS @50u | EXAONE 40 / Qwen 71 |

**역할 분담**

```
복잡한 업무 · 한국어 분석  →  EXAONE-4.0-32B-AWQ
단순 질의 · 빠른 응답     →  Qwen3-8B
```

**vLLM 실행 명령**

```bash
# GPU 단일 사용, 메모리 절반씩 분할
CUDA_VISIBLE_DEVICES=0 vllm serve LGAI-EXAONE/EXAONE-4.0-32B \
  --quantization awq \
  --gpu-memory-utilization 0.46 \
  --port 8001 &

CUDA_VISIBLE_DEVICES=0 vllm serve Qwen/Qwen3-8B \
  --gpu-memory-utilization 0.46 \
  --port 8002 &
```

---

### 구성 2 — 처리량 + 품질 균형

```
┌─────────────────────────────────────────────────────┐
│  A100 80GB                                          │
│                                                     │
│  EXAONE-4.0-32B-AWQ  ████████████  18 GB           │
│  gpt-oss-20b INT8    █████████████  20 GB           │
│  KV Cache 잔여        ██████████████████  34 GB     │
│                       └── 모델당 17 GB              │
└─────────────────────────────────────────────────────┘
```

| 항목 | 값 |
|------|---|
| 가중치 합계 | 38 GB |
| KV Cache | 34 GB (모델당 17 GB) |
| 동시 사용자 | 각 모델 12~18 유저 |
| 비고 | gpt-oss INT8 양자화로 TPS 소폭 하락 |

**역할 분담**

```
한국어 · 정밀 분석     →  EXAONE-4.0-32B-AWQ
영어 · 대용량 처리    →  gpt-oss-20b INT8
```

---

### ❌ 단일 A100에서 불가능한 조합

| 조합 | 가중치 합계 | 판정 |
|------|-----------|------|
| gemma-4-26B BF16 + gpt-oss-20b BF16 | 92 GB | ❌ VRAM 초과 |
| gemma-4-26B BF16 + EXAONE-AWQ | 70 GB | ❌ KV cache 2 GB 미만 |
| gemma-4-31B BF16 + 어떤 모델 | 62 GB+ | ❌ KV cache 없음 |

---

## A100 × 2 (두 GPU / 각 72GB, 총 144GB)

### 구성 A — 요청 조합 (gemma-4-26B + gpt-oss-20b)

```
┌──────────────────────────────┐  ┌──────────────────────────────┐
│  GPU 0 (A100 80GB)           │  │  GPU 1 (A100 80GB)           │
│                              │  │                              │
│  gemma-4-26B-A4B BF16        │  │  gpt-oss-20b BF16            │
│  ██████████████████  52 GB   │  │  ████████████████  40 GB     │
│                              │  │                              │
│  KV Cache  ████████  20 GB ✅ │  │  KV Cache  ████████████ 32 GB ✅ │
│  포트 8001                   │  │  포트 8002                   │
└──────────────────────────────┘  └──────────────────────────────┘
```

| 항목 | GPU 0 | GPU 1 |
|------|-------|-------|
| 모델 | gemma-4-26B-A4B | gpt-oss-20b |
| 정밀도 | BF16 (양자화 없음) | BF16 (양자화 없음) |
| 가중치 | 52 GB | 40 GB |
| KV Cache | 20 GB | 32 GB |
| 동시 사용자 | ~15 유저 | ~25 유저 |
| 실측 TPS @1u | 103.9 | 213.6 |
| MMLU-Pro | ~82 | ≥ o3-mini |

**특징**: 양자화 없이 원본 품질 유지. gpt-oss-20b의 MoE 특성상 KV cache 여유 충분.

**vLLM 실행 명령**

```bash
CUDA_VISIBLE_DEVICES=0 vllm serve google/gemma-4-26B-A4B-it \
  --gpu-memory-utilization 0.90 \
  --port 8001 &

CUDA_VISIBLE_DEVICES=1 vllm serve openai/gpt-oss-20b \
  --gpu-memory-utilization 0.90 \
  --port 8002 &
```

---

### 구성 B — 3모델 커버리지 ★ 가성비 최고

```
┌──────────────────────────────┐  ┌──────────────────────────────┐
│  GPU 0 (A100 80GB)           │  │  GPU 1 (A100 80GB)           │
│                              │  │                              │
│  gemma-4-26B-A4B BF16        │  │  EXAONE-4.0-32B-AWQ          │
│  ██████████████████  52 GB   │  │  ████████  18 GB             │
│                              │  │  Qwen3-8B BF16               │
│  KV Cache  ████████  20 GB ✅ │  │  ██████  16 GB               │
│  포트 8001                   │  │  KV Cache ████████████ 38 GB  │
│                              │  │  (모델당 19 GB) ✅            │
│                              │  │  포트 8002 / 8003             │
└──────────────────────────────┘  └──────────────────────────────┘
```

| 모델 | GPU | KV Cache | 동시 사용자 | 강점 |
|------|-----|---------|-----------|------|
| gemma-4-26B-A4B | 0 | 20 GB | ~15 | 고품질 범용 |
| EXAONE-4.0-32B-AWQ | 1 | 19 GB | ~15 | 한국어 전문 |
| Qwen3-8B | 1 | 19 GB | ~20 | 초고속 경량 |

**역할 분담**

```
영어 문서 분석 · 복잡한 추론   →  gemma-4-26B-A4B   (GPU 0)
한국어 업무 · 정밀 응답       →  EXAONE-4.0-32B    (GPU 1)
단순 질의 · 실시간 빠른 응답   →  Qwen3-8B         (GPU 1)
```

---

### 구성 C — 4모델 최대 커버리지

```
┌──────────────────────────────┐  ┌──────────────────────────────┐
│  GPU 0 (A100 80GB)           │  │  GPU 1 (A100 80GB)           │
│                              │  │                              │
│  gemma-4-26B-A4B AWQ  13 GB  │  │  gpt-oss-20b BF16   40 GB    │
│  EXAONE-4.0-32B  AWQ  18 GB  │  │  Qwen3-8B BF16      16 GB    │
│  합계             31 GB      │  │  합계               56 GB    │
│  KV Cache         41 GB ✅   │  │  KV Cache           16 GB ⚠️  │
└──────────────────────────────┘  └──────────────────────────────┘
```

> ⚠️ GPU 1의 Qwen3-8B KV cache 8GB: 동시 5~8 유저 수준  
> gemma-4-26B AWQ 양자화로 품질 소폭 저하 감수 필요

---

## 인프라 아키텍처 (A100 × 2 기준)

```
                         인터넷
                           │
                    ┌──────▼──────┐
                    │   RunPod    │
                    │  공개 포트   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   app.py    │  ← FastAPI + SSE
                    │  (라우터)    │
                    └──┬──────┬───┘
                       │      │
            모델명 기반 라우팅
                       │      │
              ┌────────▼─┐  ┌─▼────────┐
              │  :8001   │  │  :8002   │
              │  vLLM    │  │  vLLM    │
              │ gemma-4  │  │ gpt-oss  │
              │  GPU 0   │  │  GPU 1   │
              └──────────┘  └──────────┘
```

### app.py 라우팅 코드

```python
MODEL_ENDPOINTS = {
    "google/gemma-4-26B-A4B-it": "http://localhost:8001/v1",
    "openai/gpt-oss-20b":        "http://localhost:8002/v1",
    # 구성 B 3모델일 경우
    "LGAI-EXAONE/EXAONE-4.0-32B": "http://localhost:8003/v1",
    "Qwen/Qwen3-8B":              "http://localhost:8004/v1",
}

def get_client(model: str) -> openai.AsyncOpenAI:
    base_url = MODEL_ENDPOINTS.get(model, "http://localhost:8001/v1")
    return openai.AsyncOpenAI(base_url=base_url, api_key="EMPTY")
```

---

## 실무 다중 모델 운영 패턴

### 패턴 1 — 복잡도 기반 라우팅 (Complexity Router)

```
요청 수신
    │
    ▼
복잡도 분류기 (경량 모델 or 규칙 기반)
    │
    ├── 단순 (인사·조회)       →  Qwen3-8B       (저비용·고속)
    ├── 중간 (업무·분석)       →  EXAONE-4.0-32B (균형)
    └── 복잡 (문서·추론)       →  gemma-4-26B    (고품질)
```

**효과**: 전체 GPU 비용 40~60% 절감, 응답속도 향상

---

### 패턴 2 — 사용자 티어 분리 (User Tier)

```
무료 사용자     →  Qwen3-8B / gemma-4-E4B
일반 유료       →  EXAONE-4.0-32B / gemma-4-26B
프리미엄        →  gemma-4-31B / gpt-oss-20b
```

---

### 패턴 3 — 폭포수 재시도 (Cascading)

```
1차: 경량 모델로 응답 생성
    │
    ▼
신뢰도 점수 계산
    │
    ├── 충분 →  응답 반환
    └── 부족 →  2차: 대형 모델로 재생성 → 응답 반환
```

**효과**: 비용 절감 + 품질 보장 동시 달성

---

### 패턴 4 — Prefix Cache 공유 (vLLM 기능)

동일한 시스템 프롬프트 / RAG 컨텍스트가 반복되면 KV Cache를 재사용:

```bash
vllm serve ... --enable-prefix-caching
```

```
첫 번째 요청: 시스템 프롬프트(2000 토큰) KV 계산 → Cache 저장
이후 요청   : Cache 히트 → TTFT 대폭 감소 (수 초 → 수백 ms)
```

RAG 파이프라인에서 동일 문서를 반복 참조할 경우 특히 효과적.

---

## 구성별 최종 비교

| 구성 | 모델 수 | GPU 비용/hr | GPU당 동시 사용자 | 품질 | 추천 상황 |
|------|--------|-----------|----------------|------|---------|
| A100×1 구성1 | 2 | ~$2.5 | 15~20 | ★★★★ | 예산 제한 · 한국어 서비스 |
| A100×1 구성2 | 2 | ~$2.5 | 12~18 | ★★★★ | 처리량 우선 |
| **A100×2 구성A** | **2** | **~$5.0** | **15~25** | **★★★★★** | **유저 요청 · 품질 최우선** |
| A100×2 구성B | 3 | ~$5.0 | 15~20 | ★★★★★ | 가성비 최고 · 3역할 분담 |
| A100×2 구성C | 4 | ~$5.0 | 5~20 | ★★★★ | 최대 모델 커버리지 |

---

## 한줄 결론

| 목적 | 선택 |
|------|------|
| 예산 최소 | **A100×1** — EXAONE-AWQ + Qwen3-8B |
| 요청 조합 (gemma-4-26B + gpt-oss) | **A100×2 구성A** — GPU당 1모델 전용 |
| 가성비 최고 (3모델) | **A100×2 구성B** — GPU0=gemma-4-26B / GPU1=EXAONE-AWQ+Qwen3-8B |
| 최고 품질 배치 처리 | A100×2 + gemma-4-31B 단독 GPU 전용 |
