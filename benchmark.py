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
    "timestamp", "url_id", "url", "gpu", "gpu_count", "model", "round", "prompt",
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

    if "Qwen" in model or "zai" in model or "Xiaomi":
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
    rounds: int = 3, max_tokens: int = 8192,
    gpu_count: int = 1,
    headers: dict | None = None,
):
    """제너레이터: 라운드마다 SSE 이벤트용 dict를 yield한다."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    today = datetime.now().strftime("%Y년 %m월 %d일")

    prompts = [
        f"""[시스템 컨텍스트]
오늘 날짜: {today}
사용자: 김지수 (인사팀 HR매니저, 재직 7년)
요청 채널: 사내 AI 어시스턴트 (HR 모듈)

[검색된 관련 문서 - RAG]
---문서 1: 표준 근로계약서 템플릿 v3.2 (2025-09-01 개정)---
제3조(근무장소 및 업무내용) 근무장소는 서울특별시 강남구 테헤란로 123 본사로 하며, 업무내용은 소프트웨어 개발 및 관련 업무로 한다. 단, 회사의 필요에 의해 근무장소 및 업무내용은 변경될 수 있다.
제4조(근로시간) 1일 8시간, 1주 40시간을 기준으로 하며 시업시각 09:00, 종업시각 18:00로 한다. 단, 업무상 필요한 경우 당사자 합의 하에 연장근로를 실시할 수 있다.
제5조(임금) 월 기본급 4,200,000원으로 하며, 제수당은 회사 내규에 따라 별도 지급한다. 임금지급일은 매월 25일로 한다.
제6조(연차유급휴가) 근로기준법에 따라 연차유급휴가를 부여한다. 1년 미만 근속자는 매월 1일씩 최대 11일을 부여한다.
---문서 2: 신규입사자 온보딩 체크리스트 v2.1---
입사 D-1: 근로계약서 서명 완료, 사원증 발급 신청, 노트북 세팅 요청
입사 1일차: 인사팀 오리엔테이션(09:00-11:00), 팀 배치 및 팀장 면담, 사내 시스템 계정 발급(그룹웨어/Slack/Jira)
입사 1주차: 직무교육 이수(필수 4개 과목), 보안서약서 서명, 개인정보 처리 교육 완료
입사 1개월차: 수습평가 1차(팀장 면담), OKR 설정, 멘토 배정 확인
---문서 3: 2026년 상반기 채용 현황---
확정 입사자: 박민준(백엔드개발팀, 4/14), 이서연(디자인팀, 4/21), 최도현(영업팀, 5/1)
현재 온보딩 진행 중: 3명
평균 온보딩 완료 기간: 32일

[사용자 질문]
박민준 씨가 오늘 입사했습니다. 위 문서를 참고해서 오늘부터 1개월간의 온보딩 일정표를 작성하고, 각 단계별로 인사팀이 준비해야 할 사항과 당사자가 완료해야 할 항목을 구분해서 정리해줘. 수습평가 기준도 포함해줘.""",

        f"""[시스템 컨텍스트]
오늘 날짜: {today}
사용자: 이현우 (법무팀 계약검토 담당, 재직 4년)
요청 채널: 사내 AI 어시스턴트 (법무 모듈)

[검색된 관련 문서 - RAG]
---문서 1: (주)테크파트너스 서비스 이용계약서 초안 (수신일: {today})---
제1조(목적) 본 계약은 (주)테크파트너스(이하 "갑")와 (주)클라우드솔루션(이하 "을") 간의 SaaS 플랫폼 서비스 제공에 관한 권리와 의무를 규정함을 목적으로 한다.
제5조(서비스 수준 협약) 을은 월간 서비스 가용률 99.5% 이상을 보장한다. 가용률 미달 시 해당 월 이용료의 10%를 다음 달 청구금액에서 공제한다. 단, 천재지변, 을의 귀책 없는 제3자 인프라 장애는 예외로 한다.
제7조(데이터 처리) 을은 갑의 데이터를 계약 목적 외로 사용할 수 없으며, 계약 종료 후 30일 이내에 모든 데이터를 삭제하거나 반환하여야 한다. 단, 법령에 의한 보관 의무가 있는 경우는 예외로 한다.
제9조(손해배상) 을의 귀책으로 발생한 손해에 대해 을의 배상 한도는 해당 계약 연도의 총 이용료를 초과하지 않는다.
제11조(계약 해지) 각 당사자는 3개월 전 서면 통보로 계약을 해지할 수 있다. 갑이 이용료를 2회 이상 연속 미납한 경우 을은 즉시 해지 가능하다.
제13조(준거법 및 관할) 본 계약은 대한민국 법률에 따르며, 분쟁 발생 시 서울중앙지방법원을 관할 법원으로 한다.
---문서 2: 내부 계약 검토 기준 (법무팀 가이드라인 v4.0)---
SLA 가용률 기준: 99.9% 미만은 반드시 협상 요청. 패널티 비율: 미달 시간당 일할 계산 방식 선호.
데이터 삭제 기한: 계약 종료 후 30일 → 7일로 단축 요청 권고.
손해배상 한도: 연간 이용료 캡 조항은 삭제 또는 '실제 손해액'으로 변경 요청.
해지 통보 기간: 3개월은 과도. 1개월로 단축 협상 권고.
---문서 3: (주)테크파트너스 계약 이력---
2023년 유사 계약 체결 후 데이터 미삭제로 과태료 부과 이력 있음.
현재 월 이용료: 예상 1,200만원 (연간 1억 4,400만원)

[사용자 질문]
위 계약서 초안을 내부 가이드라인과 비교해서 리스크 항목을 분석해줘. 각 조항별로 현재 조건의 문제점, 협상 요청 사항, 우선순위(상/중/하)를 표로 정리하고, 상대방에게 보낼 수정 요청 이메일 초안도 작성해줘.""",

        f"""[시스템 컨텍스트]
오늘 날짜: {today}
사용자: 정수민 (고객성공팀 CS매니저, 재직 3년)
요청 채널: 사내 AI 어시스턴트 (CS 모듈)
티켓 ID: CS-2026-04-8821

[검색된 관련 문서 - RAG]
---문서 1: 고객 문의 원문 (접수: {today} 09:42)---
고객명: 강태양 (기업회원, 플랜: 프리미엄, 가입일: 2024-11-03)
문의 내용: "안녕하세요. 저희 회사에서 귀사 서비스를 사용한 지 약 1년 반 정도 됐는데요. 지난주부터 갑자기 대용량 파일 업로드가 계속 실패합니다. 파일 크기는 800MB 정도이고, 업로드 진행 중에 '서버 오류 500'이 뜨면서 멈춰버려요. 같은 파일을 200MB로 분할하면 되긴 하는데 매번 나누는 게 너무 불편합니다. 언제쯤 해결되나요? 이 문제 때문에 팀 전체 작업이 지연되고 있어서 답답합니다. 빠른 답변 부탁드립니다."
---문서 2: 관련 기술 문서 (RAG 검색 결과)---
[공지] 2026-04-08 배포(v2.14.0): 파일 업로드 모듈 보안 패치 적용. 단일 파일 500MB 초과 시 멀티파트 업로드 방식으로 자동 전환 로직 추가. 일부 환경에서 멀티파트 초기화 실패 버그 확인됨 → 수정 버전 v2.14.1 배포 예정(예상: 4월 17일).
[FAQ-0892] 대용량 파일 업로드 실패 시: 브라우저 캐시 삭제 후 재시도, Chrome 최신 버전 사용 권장. 임시 해결책: 파일을 500MB 이하로 분할 업로드.
[플랜 정책] 프리미엄 플랜: 단일 파일 최대 2GB, 월 저장 용량 1TB, SLA 99.9% 보장.
---문서 3: 유사 티켓 해결 이력---
CS-2026-04-8634 (4/10): 동일 증상, 브라우저 캐시 삭제로 해결 안 됨 → v2.14.1 배포 후 해결 예정 안내, 불편 사과 및 1개월 이용료 크레딧 제공.
CS-2026-04-8701 (4/11): 동일 증상, 크레딧 제공 후 고객 만족 확인.
---문서 4: 고객 등급 정책---
프리미엄 고객 장애 대응: 24시간 이내 1차 답변 필수, 불편 지속 시 크레딧 또는 이용료 감면 검토.

[사용자 질문]
위 티켓에 대해 고객에게 보낼 답변 이메일을 작성해줘. 문제 원인과 임시 해결책, 정식 패치 일정을 명확히 안내하고, 불편에 대한 적절한 보상도 제안해줘. 말투는 정중하고 신뢰감을 주는 톤으로.""",

        f"""[시스템 컨텍스트]
오늘 날짜: {today}
사용자: 오준혁 (전략기획팀 팀장, 재직 9년)
요청 채널: 사내 AI 어시스턴트 (경영기획 모듈)

[검색된 관련 문서 - RAG]
---문서 1: 2026년 1분기 사업 실적 데이터 (확정, CFO 승인)---
매출: 목표 48억원 / 실적 51.3억원 (달성률 106.9%)
영업이익: 목표 7.2억원 / 실적 8.8억원 (달성률 122.2%)
신규 고객: 목표 120개사 / 실적 134개사 (달성률 111.7%)
해지 고객: 전분기 23개사 → 이번 분기 14개사 (해지율 1.8% → 1.1%)
주요 제품별 매출: 엔터프라이즈 플랜 31.2억(+23% YoY), SMB 플랜 16.8억(+8% YoY), 신규 AI 부가서비스 3.3억(런칭 2개월)
---문서 2: 주요 영업 활동 요약---
대형 계약: (주)현대물류 엔터프라이즈 계약 체결(연간 2.4억), (주)신한캐피탈 POC 진행 중(예상 규모 연간 1.8억)
마케팅: 3월 테크서밋 참가 → 리드 47건 확보(전환 진행 중 12건)
파트너십: AWS 파트너 티어 업그레이드(셀렉트 → 어드밴스드), 공동 마케팅 예산 5천만원 확보
---문서 3: 주요 리스크 및 이슈---
v2.14.0 배포 장애로 CS 티켓 급증(4/8~4/14, 약 200건). 프리미엄 고객 이탈 위험 3건 모니터링 중.
경쟁사 A사, 유사 기능 무료 제공 발표(4/5). 중소기업 고객 이탈 문의 증가 추세.
개발 인력 부족: 백엔드 시니어 채용 2명 진행 중(목표: 5월 입사).
---문서 4: 2분기 목표 (사전 설정)---
매출 목표: 55억원, 영업이익 10억원, 신규 고객 150개사, AI 부가서비스 매출 8억원

[사용자 질문]
위 데이터를 바탕으로 2026년 1분기 경영 성과 보고서를 작성해줘. 임원 보고용으로 주요 성과 요약, 목표 대비 분석, 리스크 현황 및 대응 방향, 2분기 전망과 핵심 과제를 포함해서 한 페이지 분량으로 작성해줘. 수치는 모두 포함하고 경영진이 의사결정하기 쉬운 구조로 정리해줘.""",

        f"""[시스템 컨텍스트]
오늘 날짜: {today}
사용자: 한소희 (재무팀 FP&A 담당, 재직 5년)
요청 채널: 사내 AI 어시스턴트 (재무 모듈)

[검색된 관련 문서 - RAG]
---문서 1: 2026년 2분기 예산 편성 지침 (CFO 공문, 4/7 발송)---
편성 기준: 1분기 실적 기반 Bottom-up 방식. 매출 성장률 가정: 보수 7%, 기본 12%, 공격 18%.
비용 통제 원칙: 인건비 증가율 전년 대비 15% 이내. 마케팅 비용은 매출 대비 8% 이내. 신규 SW 구독 도입은 IT위원회 사전 승인 필수.
제출 기한: 4월 25일 17:00까지 재무팀 제출. 팀장 서명 필수.
---문서 2: 개발팀 2분기 예산 요청서 초안---
인건비: 3.8억 (전분기 대비 +18%, 시니어 채용 2명 반영)
AWS 인프라: 6,500만원 (전분기 4,200만원 대비 +55%, AI 서비스 확장)
외주 개발: 4,000만원 (UI/UX 리뉴얼 프로젝트)
소프트웨어 라이선스: 1,200만원 (신규 모니터링 툴 Datadog 도입)
교육훈련비: 800만원
합계: 5억 8,500만원
---문서 3: 재무팀 검토 기준 및 전분기 실적---
전분기 개발팀 예산: 4억 6,000만원 / 실집행: 4억 1,200만원 (집행률 89.6%)
인건비 상한 가이드라인(15% 초과 시 CFO 별도 승인 필요): 전분기 인건비 3.22억 × 115% = 3.7억 → 요청액 3.8억 초과
Datadog 도입: IT위원회 사전 승인 항목 해당, 현재 미승인 상태
---문서 4: 유사 팀 예산 승인 이력---
영업팀 2분기: 인건비 초과 요청 → CFO 면담 후 일부 조정 승인(+10%로 타협)
인프라 확장 비용: AI 서비스 관련 항목은 매출 기여 근거 제시 시 예외 승인 가능

[사용자 질문]
개발팀 예산 요청서를 검토해서 CFO 보고용 검토 의견서를 작성해줘. 가이드라인 위반 항목을 명확히 짚고, 각 항목별로 승인 가능 여부와 조건, 추가 확인이 필요한 사항을 정리해줘. 개발팀과의 협의 포인트도 제안해줘.""",
    ]
    csv_path = _get_csv_path(gpu, model, url_id)
    is_new_pod = not os.path.exists(csv_path)

    # start event
    yield {
        "event": "start",
        "gpu": gpu,
        "gpu_count": gpu_count,
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
            "gpu_count": gpu_count,
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
            "gpu_count": gpu_count,
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
