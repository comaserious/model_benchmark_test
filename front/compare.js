const API_BASE = 'http://localhost:8000';

const PALETTE = [
  '#2563eb',  // blue-600
  '#16a34a',  // green-600
  '#d97706',  // amber-600
  '#9333ea',  // purple-600
  '#0891b2',  // cyan-700
  '#7c3aed',  // violet-600
  '#ea580c',  // orange-600
  '#059669',  // emerald-600
];

let allLogs = [];
let best = {};          // key → most recent log
let gpuCharts = [];
let modelCharts = [];
let selectCharts = [];
let radarChartInst = null;

// ── Key / Label helpers ───────────────────────────────────────────────────────

function logKey(log) {
  const m = log.meta;
  return `${m.gpu}×${m.gpu_count || 1}||${m.model}`;
}

function gpuLabel(log) {
  const m = log.meta;
  const cnt = m.gpu_count || 1;
  return cnt === 1 ? m.gpu : `${m.gpu}×${cnt}`;
}

function modelLabel(log) {
  return (log.meta.model || '').split('/').pop();
}

function fullLabel(log) {
  return `${gpuLabel(log)} / ${modelLabel(log)}`;
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadData() {
  try {
    const res = await fetch(`${API_BASE}/load-test/logs`);
    if (!res.ok) return;
    allLogs = await res.json(); // sorted desc by date

    best = {};
    for (const log of allLogs) {
      const key = logKey(log);
      if (!best[key]) best[key] = log; // first = most recent
    }

    initFilters();
    renderSelectTab();
    renderTab1();
    renderTab3();
  } catch (e) {
    showEmpty('gpuChartGrid', '서버에 연결할 수 없습니다.');
    showEmpty('modelChartGrid', '서버에 연결할 수 없습니다.');
  }
}

// ── Tab 0: 선택 비교 ──────────────────────────────────────────────────────────

function renderSelectTab() {
  const logs = Object.values(best);
  const el = document.getElementById('selectCheckboxes');

  if (!logs.length) {
    el.innerHTML = '<span class="history-hint">저장된 테스트 결과가 없습니다. Load Test를 먼저 실행하세요.</span>';
    return;
  }

  // 모델별로 그룹핑
  const byModel = {};
  for (const log of logs) {
    const m = log.meta.model;
    if (!byModel[m]) byModel[m] = [];
    byModel[m].push(log);
  }

  el.innerHTML = Object.entries(byModel).map(([model, modelLogs]) => {
    const modelShort = model.split('/').pop();
    const items = modelLogs.map((log, _) => {
      const key = logKey(log);
      const gLabel = gpuLabel(log);
      const date = log.meta.date ? log.meta.date.substring(0, 10) : '';
      const maxUsers = Math.max(...log.steps.map(s => s.concurrent_users));
      return `
        <label class="combo-checkbox-item" id="label-${key.replace(/[^a-zA-Z0-9]/g, '_')}">
          <input type="checkbox" class="combo-cb" data-key="${key}">
          <span class="combo-color-dot" id="dot-${key.replace(/[^a-zA-Z0-9]/g, '_')}"></span>
          <span>${gLabel}</span>
          <span class="combo-meta">최대 ${maxUsers}명 · ${date}</span>
        </label>`;
    }).join('');

    return `
      <div class="select-combo-group">
        <div class="select-combo-group-label">${modelShort}</div>
        <div class="select-combo-items">${items}</div>
      </div>`;
  }).join('');

  // 체크 시 색상 도트 업데이트
  document.querySelectorAll('.combo-cb').forEach(cb => {
    cb.addEventListener('change', updateComboDots);
  });
}

function updateComboDots() {
  const checked = [...document.querySelectorAll('.combo-cb:checked')];
  // 전체 도트 초기화
  document.querySelectorAll('.combo-color-dot').forEach(d => {
    d.style.background = '#30363d';
  });
  document.querySelectorAll('.combo-checkbox-item').forEach(l => l.classList.remove('checked'));

  checked.forEach((cb, i) => {
    const safeKey = cb.dataset.key.replace(/[^a-zA-Z0-9]/g, '_');
    const dot = document.getElementById(`dot-${safeKey}`);
    const label = document.getElementById(`label-${safeKey}`);
    if (dot) dot.style.background = PALETTE[i % PALETTE.length];
    if (label) label.classList.add('checked');
  });
}

function runSelectCompare() {
  const checked = [...document.querySelectorAll('.combo-cb:checked')];
  if (checked.length < 2) {
    alert('2개 이상 선택하세요.');
    return;
  }

  const selectedLogs = checked.map(cb => best[cb.dataset.key]).filter(Boolean);
  const resultEl = document.getElementById('selectResult');
  resultEl.classList.remove('hidden');

  // 각 선택 항목에 색상 인덱스 부여 (체크 순서)
  const labelFn = (log, idx) => {
    const m = modelLabel(log);
    const g = gpuLabel(log);
    // 같은 모델이 여러 개면 GPU도 표시, 아니면 모델만
    const sameModelCount = selectedLogs.filter(l => l.meta.model === log.meta.model).length;
    return sameModelCount > 1 ? `${m} (${g})` : m;
  };

  // labelFn을 인덱스 없이 사용하는 버전 (renderThreeCharts 시그니처 맞춤)
  const labelFnSimple = (log) => labelFn(log, 0);

  renderThreeCharts('selectChartGrid', selectedLogs, labelFnSimple, selectCharts);
  renderDegradation('selectDegradation', selectedLogs, labelFnSimple);
  renderDetailTables(selectedLogs, labelFnSimple);

  resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderDetailTables(logs, labelFn) {
  const el = document.getElementById('selectDetailTables');
  el.innerHTML = `<div class="detail-tables-grid">${
    logs.map((log, i) => {
      const color = PALETTE[i % PALETTE.length];
      const label = labelFn(log);
      const rows = log.steps.map(step => {
        const agg = step.aggregate;
        return `<tr>
          <td>${step.concurrent_users}</td>
          <td>${agg.avg_ttft.toFixed(3)}</td>
          <td>${agg.p95_ttft.toFixed(3)}</td>
          <td>${agg.avg_tps.toFixed(2)}</td>
          <td>${agg.avg_e2e.toFixed(3)}</td>
          <td>${agg.p95_e2e.toFixed(3)}</td>
          <td>${agg.successful}/${agg.total}</td>
        </tr>`;
      }).join('');

      return `
        <div class="detail-table-block">
          <h4 style="background:${color}22; color:${color};">${label}</h4>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Users</th>
                  <th>avg TTFT</th>
                  <th>p95 TTFT</th>
                  <th>avg TPS</th>
                  <th>avg E2E</th>
                  <th>p95 E2E</th>
                  <th>성공</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    }).join('')
  }</div>`;
}

function initFilters() {
  const logs = Object.values(best);

  // Tab 1: unique models
  const models = [...new Set(logs.map(l => l.meta.model))].sort();
  const modelSel = document.getElementById('gpuCompareModel');
  if (models.length) {
    modelSel.innerHTML = models.map(m =>
      `<option value="${m}">${m.split('/').pop()}</option>`
    ).join('');
  } else {
    modelSel.innerHTML = '<option value="">데이터 없음</option>';
  }

  // Tab 2: unique gpu×count strings
  const gpuKeys = [...new Set(logs.map(l => gpuLabel(l)))].sort();
  const gpuSel = document.getElementById('modelCompareGpu');
  if (gpuKeys.length) {
    gpuSel.innerHTML = gpuKeys.map(g =>
      `<option value="${g}">${g}</option>`
    ).join('');
  } else {
    gpuSel.innerHTML = '<option value="">데이터 없음</option>';
  }
}

// ── Chart helpers ─────────────────────────────────────────────────────────────

function destroyCharts(arr) {
  arr.forEach(c => c && c.destroy());
  arr.length = 0;
}

function showEmpty(containerId, msg) {
  const el = document.getElementById(containerId);
  if (el) el.innerHTML = `<span class="history-hint">${msg}</span>`;
}

function chartCfg(labels, datasets, yLabel) {
  const FONT = "'Barlow Condensed', 'Noto Sans KR', sans-serif";
  return {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: {
            color: '#7a8898',
            font: { family: FONT, size: 11, weight: '600' },
            boxWidth: 20,
            boxHeight: 2,
            padding: 14,
          },
        },
        tooltip: {
          backgroundColor: '#1a2233',
          borderColor: '#2e3d52',
          borderWidth: 1,
          titleColor: '#c8d4e0',
          bodyColor: '#8090a4',
          titleFont: { family: FONT, size: 12, weight: '700' },
          bodyFont: { family: FONT, size: 11 },
          padding: 10,
          cornerRadius: 4,
        },
      },
      scales: {
        x: {
          title: {
            display: true, text: 'Concurrent Users',
            color: '#96a2b0', font: { family: FONT, size: 10, weight: '700' },
          },
          ticks: { color: '#8090a4', font: { family: FONT, size: 11 } },
          grid: { color: 'rgba(0,0,0,0.06)' },
          border: { color: 'rgba(0,0,0,0.10)' },
        },
        y: {
          title: {
            display: true, text: yLabel,
            color: '#96a2b0', font: { family: FONT, size: 10, weight: '700' },
          },
          ticks: { color: '#8090a4', font: { family: FONT, size: 11 } },
          grid: { color: 'rgba(0,0,0,0.06)' },
          border: { color: 'rgba(0,0,0,0.10)' },
          beginAtZero: true,
        },
      },
    },
  };
}

// ── Chart expand modal ────────────────────────────────────────────────────────

function openChartModal(labels, datasets, title, yLabel) {
  // Deep-clone datasets so the modal chart is independent
  const cloned = JSON.parse(JSON.stringify(datasets));

  const modal = document.createElement('div');
  modal.className = 'chart-modal';
  modal.innerHTML = `
    <div class="chart-modal-backdrop"></div>
    <div class="chart-modal-panel">
      <div class="chart-modal-header">
        <span class="chart-modal-title">${title}</span>
        <button class="chart-modal-close" aria-label="닫기">✕</button>
      </div>
      <div class="chart-modal-canvas-wrap">
        <canvas id="chart-modal-canvas"></canvas>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const cfg = chartCfg(labels, cloned, yLabel);
  cfg.options.maintainAspectRatio = false;
  // Slightly larger fonts for the expanded view
  cfg.options.plugins.legend.labels.font.size = 12;
  cfg.options.scales.x.ticks.font.size = 12;
  cfg.options.scales.y.ticks.font.size = 12;

  const modalChart = new Chart(document.getElementById('chart-modal-canvas'), cfg);

  const closeModal = () => {
    modalChart.destroy();
    modal.remove();
    document.removeEventListener('keydown', onKeydown);
  };

  const onKeydown = (e) => { if (e.key === 'Escape') closeModal(); };
  modal.querySelector('.chart-modal-backdrop').addEventListener('click', closeModal);
  modal.querySelector('.chart-modal-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', onKeydown);

  // Trigger enter animation on next frame
  requestAnimationFrame(() => modal.classList.add('open'));
}

// logs 배열 → 3개 차트 렌더링 (공통 x축 = 모든 concurrent_users 합집합)
function renderThreeCharts(containerId, logs, labelFn, chartsArr) {
  destroyCharts(chartsArr);
  const container = document.getElementById(containerId);

  if (!logs.length) {
    container.innerHTML = '<span class="history-hint">비교할 데이터가 없습니다.</span>';
    return;
  }

  // 공통 x축: 모든 logs의 concurrent_users 합집합, 오름차순
  const allUsers = [...new Set(
    logs.flatMap(l => l.steps.map(s => s.concurrent_users))
  )].sort((a, b) => a - b);

  // 각 로그 → dataset 3종
  const line = { borderWidth: 1.5, pointRadius: 3, pointHoverRadius: 5, tension: 0.3, fill: false, spanGaps: true };
  const ttftDS = [], e2eDS = [], tpsDS = [];

  logs.forEach((log, i) => {
    const color = PALETTE[i % PALETTE.length];
    const label = labelFn(log);
    const stepMap = {};
    log.steps.forEach(s => { stepMap[s.concurrent_users] = s.aggregate; });

    ttftDS.push({ label, data: allUsers.map(u => stepMap[u]?.avg_ttft ?? null), borderColor: color, pointBackgroundColor: color, ...line });
    e2eDS.push({  label, data: allUsers.map(u => stepMap[u]?.avg_e2e  ?? null), borderColor: color, pointBackgroundColor: color, ...line });
    tpsDS.push({  label, data: allUsers.map(u => stepMap[u]?.avg_tps  ?? null), borderColor: color, pointBackgroundColor: color, ...line });
  });

  container.innerHTML = `
    <div class="chart-wrap"><h3>TTFT (s)</h3><canvas id="${containerId}-ttft"></canvas></div>
    <div class="chart-wrap"><h3>E2E Time (s)</h3><canvas id="${containerId}-e2e"></canvas></div>
    <div class="chart-wrap"><h3>TPS</h3><canvas id="${containerId}-tps"></canvas></div>`;

  chartsArr.push(
    new Chart(document.getElementById(`${containerId}-ttft`), chartCfg(allUsers, ttftDS, 'Seconds')),
    new Chart(document.getElementById(`${containerId}-e2e`),  chartCfg(allUsers, e2eDS,  'Seconds')),
    new Chart(document.getElementById(`${containerId}-tps`),  chartCfg(allUsers, tpsDS,  'Tokens / sec')),
  );

  // Add expand-on-click to each chart wrap
  [
    [`${containerId}-ttft`, 'TTFT (s)', 'Seconds',       ttftDS],
    [`${containerId}-e2e`,  'E2E Time (s)', 'Seconds',   e2eDS],
    [`${containerId}-tps`,  'TPS', 'Tokens / sec',       tpsDS],
  ].forEach(([id, title, yLabel, ds]) => {
    const wrap = document.getElementById(id)?.closest('.chart-wrap');
    if (wrap) {
      wrap.addEventListener('click', () => openChartModal(allUsers, ds, title, yLabel));
    }
  });
}

// 성능 저하율 테이블 렌더링
function renderDegradation(containerId, logs, labelFn) {
  const el = document.getElementById(containerId);
  if (!logs.length) { el.innerHTML = ''; return; }

  const rows = logs.map(log => {
    const steps = log.steps;
    if (steps.length < 2) return null;
    const first = steps[0].aggregate;
    const last  = steps[steps.length - 1].aggregate;
    const ratio = first.avg_ttft > 0 ? (last.avg_ttft / first.avg_ttft) : null;
    return { label: labelFn(log), firstTtft: first.avg_ttft, lastTtft: last.avg_ttft, ratio,
             firstUsers: steps[0].concurrent_users, lastUsers: last.concurrent_users || steps[steps.length-1].concurrent_users };
  }).filter(Boolean);

  if (!rows.length) { el.innerHTML = ''; return; }

  const badgeClass = r => r < 2 ? 'good' : r < 4 ? 'warn' : 'bad';

  el.innerHTML = `
    <h3>부하 증가에 따른 TTFT 저하율</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>구성</th><th>1명 TTFT</th><th>최대(${rows[0]?.lastUsers}명) TTFT</th><th>저하율</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${r.label}</td>
              <td>${r.firstTtft.toFixed(3)}s</td>
              <td>${r.lastTtft.toFixed(3)}s</td>
              <td><span class="degradation-badge ${r.ratio ? badgeClass(r.ratio) : ''}">
                ${r.ratio ? r.ratio.toFixed(1) + '×' : '—'}
              </span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── Tab 1: GPU 비교 ───────────────────────────────────────────────────────────

function renderTab1() {
  const selectedModel = document.getElementById('gpuCompareModel').value;
  if (!selectedModel) return;

  const logs = Object.values(best)
    .filter(l => l.meta.model === selectedModel)
    .sort((a, b) => gpuLabel(a).localeCompare(gpuLabel(b)));

  renderThreeCharts('gpuChartGrid', logs, gpuLabel, gpuCharts);
  renderDegradation('gpuDegradation', logs, gpuLabel);
}

// ── Tab 2: 모델 비교 ──────────────────────────────────────────────────────────

function renderTab2() {
  const selectedGpu = document.getElementById('modelCompareGpu').value;
  if (!selectedGpu) return;

  const logs = Object.values(best)
    .filter(l => gpuLabel(l) === selectedGpu)
    .sort((a, b) => modelLabel(a).localeCompare(modelLabel(b)));

  renderThreeCharts('modelChartGrid', logs, modelLabel, modelCharts);
  renderDegradation('modelDegradation', logs, modelLabel);
}

// ── Tab 3: 전체 요약 ──────────────────────────────────────────────────────────

function calcCapacity(log, maxTtft, maxE2e) {
  const gpuCnt = log.meta.gpu_count || 1;
  let maxUsers = 0;
  let bestAgg = null;

  for (const step of log.steps) {
    const agg = step.aggregate;
    if (agg.successful > 0 && agg.avg_ttft <= maxTtft && agg.avg_e2e <= maxE2e) {
      maxUsers = step.concurrent_users;
      bestAgg = agg;
    }
  }

  return {
    maxUsersTotal: maxUsers,
    maxUsersPerGpu: maxUsers > 0 ? Math.floor(maxUsers / gpuCnt) : 0,
    agg: bestAgg,
  };
}

function calcDegradationRatio(log) {
  const steps = log.steps;
  if (steps.length < 2) return null;
  const first = steps[0].aggregate.avg_ttft;
  const last  = steps[steps.length - 1].aggregate.avg_ttft;
  return first > 0 ? last / first : null;
}

function renderTab3() {
  const maxTtft = parseFloat(document.getElementById('slaMaxTtft').value) || 3;
  const maxE2e  = parseFloat(document.getElementById('slaMaxE2e').value)  || 10;

  const logs = Object.values(best).sort((a, b) => {
    const ga = gpuLabel(a), gb = gpuLabel(b);
    return ga !== gb ? ga.localeCompare(gb) : modelLabel(a).localeCompare(modelLabel(b));
  });

  // ── Summary table ────────────────────────────────────────────────
  const tbody = document.getElementById('summaryTableBody');
  tbody.innerHTML = '';

  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#8b949e;">저장된 테스트 결과가 없습니다.</td></tr>';
    renderRadar(logs, maxTtft, maxE2e);
    return;
  }

  for (const log of logs) {
    const { maxUsersPerGpu, agg } = calcCapacity(log, maxTtft, maxE2e);
    const degradation = calcDegradationRatio(log);
    const date = log.meta.date ? log.meta.date.replace('T', ' ').substring(0, 16) : '—';
    const gpuCnt = log.meta.gpu_count || 1;

    const capCell = maxUsersPerGpu > 0
      ? `<span class="capacity-cell">${maxUsersPerGpu}명</span>`
      : `<span class="capacity-cell none">SLA 미충족</span>`;

    const degBadgeClass = !degradation ? '' : degradation < 2 ? 'good' : degradation < 4 ? 'warn' : 'bad';
    const degCell = degradation
      ? `<span class="degradation-badge ${degBadgeClass}">${degradation.toFixed(1)}×</span>`
      : '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${log.meta.gpu}</td>
      <td>${gpuCnt}개</td>
      <td>${modelLabel(log)}</td>
      <td>${capCell}</td>
      <td>${agg ? agg.avg_ttft.toFixed(3) + 's' : '—'}</td>
      <td>${agg ? agg.avg_tps.toFixed(2) : '—'}</td>
      <td>${agg ? agg.avg_e2e.toFixed(3) + 's' : '—'}</td>
      <td>${degCell}</td>
      <td style="color:#8b949e;font-size:0.8rem;">${date}</td>`;
    tbody.appendChild(tr);
  }

  renderRadar(logs, maxTtft, maxE2e);
}

// ── Radar chart ───────────────────────────────────────────────────────────────

function buildRadarScores(logs, maxTtft, maxE2e) {
  return logs.map(log => {
    const steps = log.steps;
    const first = steps[0]?.aggregate;
    const last  = steps[steps.length - 1]?.aggregate;
    const { maxUsersPerGpu } = calcCapacity(log, maxTtft, maxE2e);
    const degradation = calcDegradationRatio(log) ?? 10;
    const consistency = last ? (last.avg_ttft > 0 ? last.p95_ttft / last.avg_ttft : 10) : 10;

    return {
      key: logKey(log),
      label: fullLabel(log),
      singleTtft:  first ? first.avg_ttft : null,
      singleTps:   first ? first.avg_tps  : null,
      maxUsers:    maxUsersPerGpu,
      degradation,   // lower = better
      consistency,   // lower = better
    };
  });
}

function normalize(values, lowerIsBetter) {
  const valid = values.filter(v => v !== null && isFinite(v));
  if (!valid.length) return values.map(() => 0);
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  if (max === min) return values.map(v => v === null ? 0 : 50);
  return values.map(v => {
    if (v === null) return 0;
    const norm = (v - min) / (max - min); // 0~1, higher = bigger value
    return Math.round((lowerIsBetter ? 1 - norm : norm) * 100);
  });
}

function renderRadar(logs, maxTtft, maxE2e) {
  // Build checkboxes
  const checkboxesEl = document.getElementById('radarCheckboxes');
  if (!logs.length) {
    checkboxesEl.innerHTML = '<span class="history-hint">데이터 없음</span>';
    if (radarChartInst) { radarChartInst.destroy(); radarChartInst = null; }
    return;
  }

  const scores = buildRadarScores(logs, maxTtft, maxE2e);

  checkboxesEl.innerHTML = scores.map((s, i) => `
    <label class="model-checkbox-item">
      <input type="checkbox" class="radar-cb" data-idx="${i}" checked style="accent-color:${PALETTE[i % PALETTE.length]}">
      <span style="color:${PALETTE[i % PALETTE.length]}">${s.label}</span>
    </label>`).join('');

  checkboxesEl.querySelectorAll('.radar-cb').forEach(cb => {
    cb.addEventListener('change', () => drawRadar(scores));
  });

  drawRadar(scores);
}

function drawRadar(scores) {
  if (radarChartInst) { radarChartInst.destroy(); radarChartInst = null; }

  const selected = [...document.querySelectorAll('.radar-cb:checked')]
    .map(cb => scores[parseInt(cb.dataset.idx)])
    .slice(0, 6);

  if (!selected.length) return;

  // Normalize each axis across selected
  const ttftScores  = normalize(selected.map(s => s.singleTtft),  true);
  const tpsScores   = normalize(selected.map(s => s.singleTps),   false);
  const userScores  = normalize(selected.map(s => s.maxUsers),    false);
  const stabScores  = normalize(selected.map(s => s.degradation), true);
  const consScores  = normalize(selected.map(s => s.consistency), true);

  const datasets = selected.map((s, i) => ({
    label: s.label,
    data: [ttftScores[i], tpsScores[i], userScores[i], stabScores[i], consScores[i]],
    borderColor: PALETTE[i % PALETTE.length],
    backgroundColor: PALETTE[i % PALETTE.length] + '22',
    borderWidth: 2,
    pointBackgroundColor: PALETTE[i % PALETTE.length],
    pointRadius: 4,
  }));

  const FONT = "'Barlow Condensed', 'Noto Sans KR', sans-serif";
  radarChartInst = new Chart(document.getElementById('radarChart'), {
    type: 'radar',
    data: {
      labels: ['TTFT 응답성', 'TPS 처리량', 'GPU당\n최대 사용자', '부하 안정성', '응답 일관성'],
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      scales: {
        r: {
          min: 0, max: 100,
          ticks: { display: false, stepSize: 25 },
          grid:        { color: 'rgba(0,0,0,0.07)' },
          angleLines:  { color: 'rgba(0,0,0,0.10)' },
          pointLabels: {
            color: '#7a8898',
            font: { family: FONT, size: 12, weight: '700' },
          },
        },
      },
      plugins: {
        legend: {
          labels: {
            color: '#7a8898',
            font: { family: FONT, size: 11, weight: '600' },
            boxWidth: 20,
            boxHeight: 2,
            padding: 14,
          },
        },
        tooltip: {
          backgroundColor: '#1a2233',
          borderColor: '#2e3d52',
          borderWidth: 1,
          titleColor: '#c8d4e0',
          bodyColor: '#8090a4',
          titleFont: { family: FONT, size: 12, weight: '700' },
          bodyFont: { family: FONT, size: 11 },
          padding: 10,
          cornerRadius: 4,
        },
      },
    },
  });
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    const panel = document.getElementById(`tab-${btn.dataset.tab}`);
    panel.classList.remove('hidden');

    if (btn.dataset.tab === 'model')   renderTab2();
    if (btn.dataset.tab === 'summary') renderTab3();
    if (btn.dataset.tab === 'gpu')     renderTab1();
  });
});

document.getElementById('runSelectCompare').addEventListener('click', runSelectCompare);
document.getElementById('gpuCompareModel').addEventListener('change', renderTab1);
document.getElementById('modelCompareGpu').addEventListener('change', renderTab2);
document.getElementById('applySlaBtn').addEventListener('click', renderTab3);

// ── Init ──────────────────────────────────────────────────────────────────────

loadData();
