# 테스트 모델 품질 벤치마크 & 순위

> 작성일: 2026-04-15  
> 기준: load_test_logs에 기록된 모델들의 공식 벤치마크 수치 및 2025~2026년 리더보드 조사  
> ⚠️ 이 문서는 **응답 품질·정확도** 기준입니다. 속도(TTFT/TPS)는 Load Test 결과를 참고하세요.

---

## 테스트된 모델 목록

| 모델 ID | 제조사 | 파라미터 | 출시 |
|---------|--------|---------|------|
| `Qwen/Qwen3-8B` | Alibaba | 8B | 2025.04 |
| `google/gemma-3-12b-it` | Google DeepMind | 12B | 2025.03 |
| `google/gemma-4-E4B-it` | Google DeepMind | MoE ~4B active | 2026.04 |
| `google/gemma-4-26B-A4B-it` | Google DeepMind | MoE 26B / 4B active | 2026.04 |
| `google/gemma-4-31B-it` | Google DeepMind | 31B | 2026.04 |
| `deepseek-ai/DeepSeek-R1-Distill-Qwen-32B` | DeepSeek | 32B (추론 특화) | 2025.01 |
| `neuralmagic/DeepSeek-R1-Distill-Llama-70B-quantized.w4a16` | NeuralMagic × DeepSeek | 70B W4A16 quantized | 2025.01 |
| `LGAI-EXAONE/EXAONE-4.0-32B` (AWQ / FP8) | LG AI Research | 32B | 2025.07 |
| `openai/gpt-oss-20b` | OpenAI | MoE 20B / 3.6B active | 2025.08 |

---

## 벤치마크 지표 설명

| 지표 | 측정 내용 | 만점 |
|------|---------|------|
| **MMLU-Pro** | 57개 분야 지식 (전문가 수준, 선택지 10개) | 100 |
| **GPQA Diamond** | 박사급 과학 문제 (물리·화학·생물) | 100 |
| **MATH-500** | 대학 수준 수학 문제 풀이 | 100 |
| **AIME 2024/25** | 미국 수학 올림피아드 예선 | 100 |
| **HumanEval** | Python 코드 생성 정확도 | 100 |
| **LiveCodeBench** | 실전 코딩 문제 (코드포스 등) | 100 |

---

## 벤치마크 수치 비교표

### 범용 능력 (MMLU-Pro · GPQA)

| 모델 | MMLU-Pro | GPQA Diamond | 비고 |
|------|----------|--------------|------|
| **EXAONE-4.0-32B** | **81.8** | **75.4** | 한국어 최강 |
| **Gemma-4-31B** | **85.2** | **84.3** | 전체 오픈소스 3위 |
| Gemma-4-26B (A4B) | ~82 | 82.3 | MoE, 메모리 효율 |
| gpt-oss-20b | ≥ o3-mini | — | o3-mini 수준 |
| Gemma-3-12B-it | 60.0 | 40.9 | 구세대 |
| Qwen3-8B | 57.9 | — | 8B 최강 |
| Gemma-4-E4B | 42.5 | — | 엣지 특화 |

### 수학 · 추론 능력 (MATH-500 · AIME)

| 모델 | MATH-500 | AIME 2024 | AIME 2025 |
|------|----------|-----------|-----------|
| **DeepSeek-R1-Distill-Llama-70B** | **94.5** | **70.0** | — |
| **DeepSeek-R1-Distill-Qwen-32B** | **94.3** | **72.6** | — |
| **EXAONE-4.0-32B** | — | — | **85.3** |
| Gemma-4-31B | — | **89.2 (AIME 2026)** | — |
| Gemma-4-26B (A4B) | — | 88.3 (AIME 2026) | — |
| Qwen3-8B | 62.0 | — | — |
| Gemma-3-12B-it | 43.3 | — | — |

> DeepSeek R1 계열은 **추론 전용 모델** (chain-of-thought 필수). 범용 대화보다 수학·코딩 특화.

### 코딩 능력 (HumanEval · LiveCodeBench)

| 모델 | HumanEval | LiveCodeBench |
|------|-----------|---------------|
| **Gemma-4-31B** | — | **80.0** |
| EXAONE-4.0-32B | — | 66.7 |
| DeepSeek-R1-Distill-Llama-70B | — | 57.5 |
| DeepSeek-R1-Distill-Qwen-32B | — | 57.2 |
| Gemma-3-12B-it | **85.4** | 13.7 |
| Qwen3-8B | 72.2 | — |

---

## 종합 순위 (테스트 모델 기준)

> 🥇 범용 능력 + 코딩 + 추론을 종합한 순위

| 순위 | 모델 | 강점 | 약점 | 비고 |
|------|------|------|------|------|
| 🥇 1 | **Gemma-4-31B-it** | 전방위 최강 (MMLU-Pro 85.2, GPQA 84.3, LiveCode 80) | VRAM 많이 필요 | 전체 오픈소스 Top 3 |
| 🥈 2 | **EXAONE-4.0-32B** | 범용+한국어 모두 강함 (MMLU-Pro 81.8, AIME 85.3) | 상대적으로 신규 | **한국어 서비스 최우선 권장** |
| 🥉 3 | **Gemma-4-26B-A4B-it** | Gemma-4-31B와 거의 동급, 메모리 절반 | 31B보다 미세하게 낮음 | MoE 구조로 효율적 |
| 4 | **DeepSeek-R1-Distill-Llama-70B** | 수학·추론 최고 (MATH 94.5) | 추론 특화라 대화 품질 다소 낮음 | 양자화 버전 (정밀도 소폭 감소) |
| 5 | **DeepSeek-R1-Distill-Qwen-32B** | 수학·추론 강함 (MATH 94.3) | 동상이몽 (추론 전용) | 70B보다 가볍고 비슷한 성능 |
| 6 | **gpt-oss-20b** | MoE로 경량·고성능 (o3-mini 수준) | 벤치마크 제한적 공개 | OpenAI 오픈소스 첫 모델 |
| 7 | **Qwen3-8B** | 8B 최강, 동급 대비 월등 | 절대적 성능은 대형 모델 미달 | 경량 서비스에 최적 |
| 8 | **Gemma-3-12B-it** | HumanEval 85.4, 구세대 중 우수 | Gemma-4 대비 전반적 열세 | 레거시, 교체 권장 |
| 9 | **Gemma-4-E4B-it** | 엣지 디바이스 배포 가능 | 대형 모델 대비 제한적 능력 | 온디바이스 특화 |

---

## 용도별 추천

| 사용 목적 | 추천 모델 | 이유 |
|----------|----------|------|
| **한국어 업무 AI** | EXAONE-4.0-32B | 한국어 특화, 범용 성능 우수 |
| **최고 품질 범용** | Gemma-4-31B-it | 전체 오픈소스 Top 3 |
| **수학/코딩 전문** | DeepSeek-R1-Distill-Qwen-32B | MATH 94.3, AIME 72.6 |
| **메모리 효율** | Gemma-4-26B-A4B (MoE) 또는 gpt-oss-20b | 고성능이면서 VRAM 적게 사용 |
| **경량 빠른 응답** | Qwen3-8B | 8B 최강, 낮은 VRAM |
| **엣지/모바일** | Gemma-4-E4B-it | 16GB 이하 환경 |

---

## 모델별 특이사항

### EXAONE-4.0-32B (LG AI Research)
- 한국 최초 오픈웨이트 하이브리드 AI (Reasoning + Non-reasoning 통합)
- 14조 토큰 학습 (EXAONE 3.0 대비 2배)
- KMMLU-Redux, KMMLU-Pro 포함 한국어 평가 공식 수행
- AWQ / FP8 양자화 버전 모두 제공

### Gemma-4 시리즈 (Google DeepMind, 2026.04)
- E2B / E4B / 26B / 31B 4종 동시 출시
- Apache 2.0 라이선스 (상업적 사용 가능)
- 256K 컨텍스트 윈도우
- 31B: Arena AI 전체 오픈소스 3위

### DeepSeek-R1-Distill 계열
- 원본 DeepSeek-R1 671B의 추론 능력을 소형 모델에 증류
- **Thinking mode 필수**: `<think>...</think>` 내부 추론 과정 포함 → 토큰 수 크게 증가
- 수학/코딩 특화이며 일반 대화용으로는 과함
- 70B는 NeuralMagic의 W4A16 양자화 버전 (원본 대비 소폭 성능 감소)

### gpt-oss-20b (OpenAI, 2025.08)
- OpenAI 최초 오픈웨이트 공개 모델
- MoE 구조: 20B total / 3.6B active — 16GB VRAM에서 구동 가능
- o3-mini 수준 성능, 일부 벤치마크에서 120B 모델 초과
- 상업적 사용 가능

### Qwen3-8B (Alibaba, 2025.04)
- 8B 파라미터로 Qwen2.5-14B 초과하는 성능
- Thinking mode 지원 (enable_thinking 옵션)
- 한국어 포함 100+ 언어 지원

---

## 외부 리더보드 참고 링크

| 리소스 | URL |
|--------|-----|
| Hugging Face Open LLM Leaderboard | https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard |
| Artificial Analysis Leaderboard | https://artificialanalysis.ai/leaderboards/models |
| BenchLM.ai 순위 | https://benchlm.ai/blog/posts/best-open-source-llm |
| Qwen3 Technical Report | https://arxiv.org/html/2505.09388v1 |
| Gemma 4 공식 블로그 | https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/ |
| DeepSeek-R1 Hugging Face | https://huggingface.co/deepseek-ai/DeepSeek-R1 |
| EXAONE-4.0-32B Hugging Face | https://huggingface.co/LGAI-EXAONE/EXAONE-4.0-32B |
| gpt-oss 소개 (OpenAI) | https://openai.com/index/introducing-gpt-oss/ |
