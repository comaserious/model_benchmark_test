const API_BASE = 'http://localhost:8000';

// DOM refs
const form = document.getElementById('loadTestForm');
const runBtn = document.getElementById('runBtn');
const modeInput = document.getElementById('mode');
const runpodFields = document.getElementById('runpodFields');
const apiFields = document.getElementById('apiFields');
const stepsValueInput = document.getElementById('stepsValue');
const customStepFields = document.getElementById('customStepFields');
const progressCard = document.getElementById('progressCard');
const stepIndicator = document.getElementById('stepIndicator');
const stepProgressFill = document.getElementById('stepProgressFill');
const userCardsEl = document.getElementById('userCards');
const stepSummaryEl = document.getElementById('stepSummary');
const chartsCard = document.getElementById('chartsCard');
const stepTableBody = document.getElementById('stepTableBody');
const modelCheckboxesEl = document.getElementById('modelCheckboxes');
const budgetResult = document.getElementById('budgetResult');
const budgetTableBody = document.getElementById('budgetTableBody');

let ttftChart = null;
let e2eChart = null;
let tpsChart = null;

// ── Mode toggle ──────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const m = btn.dataset.mode;
    modeInput.value = m;
    runpodFields.classList.toggle('hidden', m !== 'runpod');
    apiFields.classList.toggle('hidden', m !== 'api');
  });
});

document.getElementById('provider').addEventListener('change', e => {
  const presets = {
    OpenAI: 'https://api.openai.com',
    Google: 'https://generativelanguage.googleapis.com',
    Custom: '',
  };
  const base = document.getElementById('apiBase');
  if (presets[e.target.value] !== undefined) base.value = presets[e.target.value];
});

// ── Step presets ─────────────────────────────────────────────────────────────
document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.step-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (btn.dataset.steps === 'custom') {
      customStepFields.classList.remove('hidden');
      updateCustomSteps();
    } else {
      customStepFields.classList.add('hidden');
      stepsValueInput.value = btn.dataset.steps;
    }
  });
});

['stepStart', 'stepEnd', 'stepIncrement'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateCustomSteps);
});

function updateCustomSteps() {
  const start = parseInt(document.getElementById('stepStart').value) || 1;
  const end = parseInt(document.getElementById('stepEnd').value) || 20;
  const inc = parseInt(document.getElementById('stepIncrement').value) || 5;
  const steps = [];
  for (let i = start; i <= end; i += inc) steps.push(i);
  if (steps[steps.length - 1] !== end) steps.push(end);
  stepsValueInput.value = steps.join(',');
}

function getSteps() {
  return stepsValueInput.value.split(',').map(Number).filter(n => n > 0);
}

// ── Form submit ──────────────────────────────────────────────────────────────
form.addEventListener('submit', async e => {
  e.preventDefault();
  await runLoadTest();
});

async function runLoadTest() {
  const mode = modeInput.value;
  const steps = getSteps();
  const rounds = parseInt(document.getElementById('rounds').value) || 1;
  const maxTokens = parseInt(document.getElementById('maxTokens').value) || 256;

  let body = { mode, steps, rounds, max_tokens: maxTokens };

  if (mode === 'runpod') {
    const urlId = document.getElementById('urlId').value.trim();
    const gpu = document.getElementById('gpu').value;
    const gpuCount = parseInt(document.getElementById('gpuCount').value) || 1;
    if (!urlId || !gpu) { alert('URL ID와 GPU를 입력하세요'); return; }
    body.url_id = urlId;
    body.gpu = gpu;
    body.gpu_count = gpuCount;
  } else {
    const apiModel = document.getElementById('apiModel').value.trim();
    const apiBase = document.getElementById('apiBase').value.trim();
    const apiKey = document.getElementById('apiKey').value.trim();
    const provider = document.getElementById('provider').value;
    if (!apiModel || !apiBase || !apiKey) { alert('API 정보를 모두 입력하세요'); return; }
    body.model = apiModel;
    body.api_base = apiBase;
    body.api_key = apiKey;
    body.provider = provider;
  }

  // Reset UI
  runBtn.disabled = true;
  progressCard.classList.remove('hidden');
  chartsCard.classList.add('hidden');
  userCardsEl.innerHTML = '';
  stepSummaryEl.classList.add('hidden');
  stepTableBody.innerHTML = '';
  if (ttftChart) { ttftChart.destroy(); ttftChart = null; }
  if (e2eChart) { e2eChart.destroy(); e2eChart = null; }
  if (tpsChart) { tpsChart.destroy(); tpsChart = null; }

  const chartLabels = [];
  const ttftAvg = [], ttftP95 = [];
  const e2eAvg = [], e2eP95 = [];
  const tpsAvg = [];

  try {
    const res = await fetch(`${API_BASE}/load-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let data;
        try { data = JSON.parse(line.slice(6)); } catch { continue; }
        handleEvent(data, steps, chartLabels, ttftAvg, ttftP95, e2eAvg, e2eP95, tpsAvg);
      }
    }
  } catch (err) {
    stepIndicator.textContent = `Error: ${err.message}`;
  } finally {
    runBtn.disabled = false;
    await loadBudgetData();
  }
}

// ── SSE event handler ────────────────────────────────────────────────────────
function handleEvent(data, steps, labels, ttftAvg, ttftP95, e2eAvg, e2eP95, tpsAvg) {
  switch (data.event) {
    case 'test_start':
      stepProgressFill.style.width = '0%';
      stepIndicator.textContent = `Step 0 / ${data.total_steps} — 준비 중`;
      break;

    case 'step_start': {
      const pct = ((data.step - 1) / data.total_steps) * 100;
      stepProgressFill.style.width = `${pct}%`;
      stepIndicator.textContent = `Step ${data.step} / ${data.total_steps} — ${data.concurrent_users}명 동시 실행 중`;
      stepSummaryEl.classList.add('hidden');
      userCardsEl.innerHTML = '';
      for (let i = 1; i <= data.concurrent_users; i++) {
        const card = document.createElement('div');
        card.className = 'user-card running';
        card.id = `uc-${i}`;
        card.innerHTML = `
          <div class="user-label">User ${i}</div>
          <div class="running-indicator">
            <div class="spinner" style="width:12px;height:12px;border-width:2px;"></div>
            <span>실행 중...</span>
          </div>`;
        userCardsEl.appendChild(card);
      }
      break;
    }

    case 'user_done': {
      const card = document.getElementById(`uc-${data.user_id}`);
      if (!card) break;
      if (data.success) {
        card.className = 'user-card done';
        card.innerHTML = `
          <div class="user-label">User ${data.user_id}</div>
          <div class="user-metrics">
            <div>TTFT <span class="metric-val">${data.ttft_s.toFixed(3)}s</span></div>
            <div>TPS <span class="metric-val">${data.tps.toFixed(2)}</span></div>
            <div>E2E <span class="metric-val">${data.e2e_time_s.toFixed(3)}s</span></div>
          </div>`;
      } else {
        card.className = 'user-card failed';
        card.innerHTML = `
          <div class="user-label">User ${data.user_id}</div>
          <div style="color:#f85149;font-size:0.82rem;margin-top:4px;">Failed</div>`;
      }
      break;
    }

    case 'step_done': {
      const agg = data.aggregate;
      const pct = (data.step / steps.length) * 100;
      stepProgressFill.style.width = `${pct}%`;

      stepSummaryEl.classList.remove('hidden');
      stepSummaryEl.innerHTML = `
        <span>avg TTFT <span class="s-val">${agg.avg_ttft.toFixed(3)}s</span></span>
        <span>avg TPS <span class="s-val">${agg.avg_tps.toFixed(2)}</span></span>
        <span>avg E2E <span class="s-val">${agg.avg_e2e.toFixed(3)}s</span></span>
        <span>성공 <span class="s-val">${agg.successful}/${agg.total}</span></span>`;

      labels.push(data.concurrent_users);
      ttftAvg.push(agg.avg_ttft);
      ttftP95.push(agg.p95_ttft);
      e2eAvg.push(agg.avg_e2e);
      e2eP95.push(agg.p95_e2e);
      tpsAvg.push(agg.avg_tps);

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${data.concurrent_users}</td>
        <td>${agg.avg_ttft.toFixed(3)}</td>
        <td>${agg.p95_ttft.toFixed(3)}</td>
        <td>${agg.max_ttft.toFixed(3)}</td>
        <td>${agg.avg_tps.toFixed(2)}</td>
        <td>${agg.min_tps.toFixed(2)}</td>
        <td>${agg.avg_e2e.toFixed(3)}</td>
        <td>${agg.p95_e2e.toFixed(3)}</td>
        <td>${agg.max_e2e.toFixed(3)}</td>
        <td>${agg.successful}/${agg.total}</td>`;
      stepTableBody.appendChild(tr);
      break;
    }

    case 'test_done':
      stepProgressFill.style.width = '100%';
      stepIndicator.textContent = `완료 — ${steps.length}단계 테스트 종료`;
      chartsCard.classList.remove('hidden');
      renderCharts(labels, ttftAvg, ttftP95, e2eAvg, e2eP95, tpsAvg);
      break;

    case 'error':
      stepIndicator.textContent = `Error: ${data.detail}`;
      break;
  }
}

// ── Charts ───────────────────────────────────────────────────────────────────
function makeChartConfig(labels, datasets, yLabel) {
  return {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 14 } },
      },
      scales: {
        x: {
          title: { display: true, text: 'Concurrent Users', color: '#8b949e', font: { size: 11 } },
          ticks: { color: '#8b949e' },
          grid: { color: '#21262d' },
        },
        y: {
          title: { display: true, text: yLabel, color: '#8b949e', font: { size: 11 } },
          ticks: { color: '#8b949e' },
          grid: { color: '#21262d' },
          beginAtZero: true,
        },
      },
    },
  };
}

function renderCharts(labels, ttftAvg, ttftP95, e2eAvg, e2eP95, tpsAvg) {
  const line = { borderWidth: 2, pointRadius: 4, tension: 0.3, fill: false };

  ttftChart = new Chart(document.getElementById('ttftChart'), makeChartConfig(labels, [
    { label: 'avg TTFT', data: ttftAvg, borderColor: '#58a6ff', pointBackgroundColor: '#58a6ff', ...line },
    { label: 'p95 TTFT', data: ttftP95, borderColor: '#388bfd', borderDash: [4, 4], pointBackgroundColor: '#388bfd', ...line },
  ], 'Seconds'));

  e2eChart = new Chart(document.getElementById('e2eChart'), makeChartConfig(labels, [
    { label: 'avg E2E', data: e2eAvg, borderColor: '#d29922', pointBackgroundColor: '#d29922', ...line },
    { label: 'p95 E2E', data: e2eP95, borderColor: '#bb8009', borderDash: [4, 4], pointBackgroundColor: '#bb8009', ...line },
  ], 'Seconds'));

  tpsChart = new Chart(document.getElementById('tpsChart'), makeChartConfig(labels, [
    { label: 'avg TPS', data: tpsAvg, borderColor: '#3fb950', pointBackgroundColor: '#3fb950', ...line },
  ], 'Tokens / sec'));
}

// ── History ──────────────────────────────────────────────────────────────────
let histTtftChart = null;
let histE2eChart = null;
let histTpsChart = null;

function renderHistory(logs) {
  const el = document.getElementById('historyList');
  if (!logs || logs.length === 0) {
    el.innerHTML = '<span class="history-hint">저장된 결과가 없습니다.</span>';
    return;
  }

  el.innerHTML = `
    <div class="table-wrap">
      <table id="historyTable">
        <thead>
          <tr>
            <th>날짜</th>
            <th>GPU</th>
            <th>수량</th>
            <th>모델</th>
            <th>Steps</th>
            <th>최대 사용자</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map((log, i) => {
            const m = log.meta;
            const maxUsers = Math.max(...(log.steps || []).map(s => s.concurrent_users));
            const date = m.date ? m.date.replace('T', ' ').substring(0, 16) : '—';
            const gpuCount = m.gpu_count || 1;
            return `<tr class="history-row" data-idx="${i}" style="cursor:pointer;">
              <td>${date}</td>
              <td>${m.gpu}</td>
              <td>${gpuCount}개</td>
              <td>${(m.model || '').split('/').pop()}</td>
              <td>${(m.steps || []).join(' → ')}</td>
              <td>${maxUsers}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  document.querySelectorAll('.history-row').forEach(row => {
    row.addEventListener('click', () => {
      document.querySelectorAll('.history-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      showHistoryDetail(logs[parseInt(row.dataset.idx)]);
    });
  });
}

function showHistoryDetail(log) {
  const detail = document.getElementById('historyDetail');
  const title = document.getElementById('historyDetailTitle');
  const m = log.meta;
  const date = m.date ? m.date.replace('T', ' ').substring(0, 16) : '—';
  title.textContent = `${m.gpu} / ${m.model} — ${date}`;
  detail.classList.remove('hidden');

  const labels = [], ttftAvg = [], ttftP95 = [], e2eAvg = [], e2eP95 = [], tpsAvg = [];
  const tbody = document.getElementById('histStepTableBody');
  tbody.innerHTML = '';

  for (const step of log.steps) {
    const agg = step.aggregate;
    labels.push(step.concurrent_users);
    ttftAvg.push(agg.avg_ttft);
    ttftP95.push(agg.p95_ttft);
    e2eAvg.push(agg.avg_e2e);
    e2eP95.push(agg.p95_e2e);
    tpsAvg.push(agg.avg_tps);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${step.concurrent_users}</td>
      <td>${agg.avg_ttft.toFixed(3)}</td>
      <td>${agg.p95_ttft.toFixed(3)}</td>
      <td>${agg.max_ttft.toFixed(3)}</td>
      <td>${agg.avg_tps.toFixed(2)}</td>
      <td>${agg.min_tps.toFixed(2)}</td>
      <td>${agg.avg_e2e.toFixed(3)}</td>
      <td>${agg.p95_e2e.toFixed(3)}</td>
      <td>${agg.max_e2e.toFixed(3)}</td>
      <td>${agg.successful}/${agg.total}</td>`;
    tbody.appendChild(tr);
  }

  if (histTtftChart) { histTtftChart.destroy(); histTtftChart = null; }
  if (histE2eChart) { histE2eChart.destroy(); histE2eChart = null; }
  if (histTpsChart) { histTpsChart.destroy(); histTpsChart = null; }

  const line = { borderWidth: 2, pointRadius: 4, tension: 0.3, fill: false };
  histTtftChart = new Chart(document.getElementById('histTtftChart'), makeChartConfig(labels, [
    { label: 'avg TTFT', data: ttftAvg, borderColor: '#58a6ff', pointBackgroundColor: '#58a6ff', ...line },
    { label: 'p95 TTFT', data: ttftP95, borderColor: '#388bfd', borderDash: [4, 4], pointBackgroundColor: '#388bfd', ...line },
  ], 'Seconds'));
  histE2eChart = new Chart(document.getElementById('histE2eChart'), makeChartConfig(labels, [
    { label: 'avg E2E', data: e2eAvg, borderColor: '#d29922', pointBackgroundColor: '#d29922', ...line },
    { label: 'p95 E2E', data: e2eP95, borderColor: '#bb8009', borderDash: [4, 4], pointBackgroundColor: '#bb8009', ...line },
  ], 'Seconds'));
  histTpsChart = new Chart(document.getElementById('histTpsChart'), makeChartConfig(labels, [
    { label: 'avg TPS', data: tpsAvg, borderColor: '#3fb950', pointBackgroundColor: '#3fb950', ...line },
  ], 'Tokens / sec'));

  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Budget Calculator ────────────────────────────────────────────────────────
let budgetLogs = [];

async function loadBudgetData() {
  try {
    const res = await fetch(`${API_BASE}/load-test/logs`);
    if (!res.ok) return;
    budgetLogs = await res.json();
    renderHistory(budgetLogs);
    renderModelCheckboxes();
  } catch { /* no logs yet */ }
}

function renderModelCheckboxes() {
  const seen = new Set();
  const items = [];
  for (const log of budgetLogs) {
    const key = `${log.meta.gpu}||${log.meta.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      items.push({ gpu: log.meta.gpu, model: log.meta.model, key });
    }
  }

  if (items.length === 0) {
    modelCheckboxesEl.innerHTML = '<span class="history-hint">부하 테스트 데이터가 없습니다. 먼저 테스트를 실행하세요.</span>';
    return;
  }

  modelCheckboxesEl.innerHTML = items.map(({ gpu, model, key }) => `
    <label class="model-checkbox-item">
      <input type="checkbox" value="${key}" checked>
      <span>${gpu} / ${model.split('/').pop()}</span>
    </label>`).join('');
}

function calcGpuRow(log, targetUsers, maxTtft, maxE2e) {
  const testGpuCount = log.meta.gpu_count || 1;
  let maxTotalUsers = 0;  // 테스트 당시 전체 사용자 수 (GPU 여러 개 합산)
  let lastValidAgg = null;

  for (const step of log.steps) {
    const agg = step.aggregate;
    if (agg.successful > 0 && agg.avg_ttft <= maxTtft && agg.avg_e2e <= maxE2e) {
      maxTotalUsers = step.concurrent_users;
      lastValidAgg = agg;
    }
  }

  // GPU 1개당 처리 가능 사용자 = 테스트 총 사용자 / 테스트에 사용한 GPU 수
  const maxUsersPerGpu = maxTotalUsers > 0 ? maxTotalUsers / testGpuCount : 0;
  const neededGpus = maxUsersPerGpu > 0 ? Math.ceil(targetUsers / maxUsersPerGpu) : null;

  return {
    gpu: log.meta.gpu,
    gpuCount: testGpuCount,
    model: log.meta.model,
    maxUsersPerGpu: Math.floor(maxUsersPerGpu),
    neededGpus,
    avgTtft: lastValidAgg ? lastValidAgg.avg_ttft : null,
    avgE2e: lastValidAgg ? lastValidAgg.avg_e2e : null,
  };
}

function appendBudgetRow(row, label) {
  const neededCell = row.neededGpus !== null
    ? `<strong>${row.neededGpus}</strong>`
    : '<span style="color:#f85149">데이터 부족</span>';
  const ttftCell = row.avgTtft !== null ? `${row.avgTtft.toFixed(3)}s` : '—';
  const e2eCell = row.avgE2e !== null ? `${row.avgE2e.toFixed(3)}s` : '—';
  const maxUsersCell = row.maxUsersPerGpu > 0
    ? `${row.maxUsersPerGpu} <span style="color:#8b949e;font-size:0.8em;">(테스트: ${row.gpuCount}개)</span>`
    : '—';

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${label}</td>
    <td>${row.gpu}</td>
    <td>${neededCell}</td>
    <td>${maxUsersCell}</td>
    <td>${ttftCell}</td>
    <td>${e2eCell}</td>`;
  budgetTableBody.appendChild(tr);
}

document.getElementById('calcBudgetBtn').addEventListener('click', () => {
  const targetUsers = parseInt(document.getElementById('targetUsers').value) || 20;
  const maxTtft = parseFloat(document.getElementById('maxTtft').value) || 3;
  const maxE2e = parseFloat(document.getElementById('maxE2e').value) || 10;

  const selectedKeys = Array.from(
    document.querySelectorAll('#modelCheckboxes input[type="checkbox"]:checked')
  ).map(cb => cb.value);

  if (selectedKeys.length === 0) { alert('모델을 하나 이상 선택하세요'); return; }

  // Most recent log per key (already sorted desc by date from API)
  const byKey = {};
  for (const log of budgetLogs) {
    const key = `${log.meta.gpu}||${log.meta.model}`;
    if (!byKey[key]) byKey[key] = log;
  }

  budgetTableBody.innerHTML = '';

  const rows = [];
  for (const key of selectedKeys) {
    const log = byKey[key];
    if (!log) continue;
    const row = calcGpuRow(log, targetUsers, maxTtft, maxE2e);
    rows.push(row);
    appendBudgetRow(row, `단일 모델 (${row.model.split('/').pop()})`);
  }

  // Multi-model summary row (2+ selected)
  if (rows.length >= 2) {
    const totalGpus = rows.reduce((s, r) => s + (r.neededGpus ?? 0), 0);
    const modelNames = rows.map(r => r.model.split('/').pop()).join(' + ');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>멀티 모델 (${modelNames})</strong></td>
      <td>혼합</td>
      <td><strong>${totalGpus > 0 ? totalGpus : '데이터 부족'}</strong></td>
      <td>—</td>
      <td>—</td>
      <td>—</td>`;
    budgetTableBody.appendChild(tr);
  }

  budgetResult.classList.remove('hidden');
});

// Initial load
loadBudgetData();
