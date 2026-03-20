const API_BASE = "http://localhost:8000";

const filterGpu = document.getElementById("filterGpu");
const filterModel = document.getElementById("filterModel");
const filterPod = document.getElementById("filterPod");
const overviewGrid = document.getElementById("overviewGrid");
const gpuChart = document.getElementById("gpuChart");
const modelChart = document.getElementById("modelChart");
const warmupChart = document.getElementById("warmupChart");
const sessionsBody = document.getElementById("sessionsBody");
const roundsBody = document.getElementById("roundsBody");
const roundCount = document.getElementById("roundCount");
const roundsPaging = document.getElementById("roundsPaging");

let allData = [];
let roundsPage = 1;
const ROUNDS_PER_PAGE = 20;

document.getElementById("refreshBtn").addEventListener("click", fetchData);
filterGpu.addEventListener("change", onFilterChange);
filterModel.addEventListener("change", onFilterChange);
filterPod.addEventListener("change", onFilterChange);

fetchData();

async function fetchData() {
  try {
    const res = await fetch(`${API_BASE}/benchmark/logs`);
    allData = await res.json();
    populateFilters();
    render();
  } catch (err) {
    overviewGrid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">Failed to load data: ${err.message}</div>`;
  }
}

function populateFilters() {
  const gpus = [...new Set(allData.map((r) => r.gpu))].sort();
  const models = [...new Set(allData.map((r) => r.model))].sort();
  const pods = [...new Set(allData.map((r) => r.url_id))].sort();

  setOptions(filterGpu, gpus);
  setOptions(filterModel, models);
  setOptions(filterPod, pods);
}

function setOptions(select, values) {
  const current = select.value;
  select.innerHTML = '<option value="">All</option>';
  values.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  });
  if (values.includes(current)) select.value = current;
}

function onFilterChange() {
  render();
}

function getFiltered() {
  return allData.filter((r) => {
    if (filterGpu.value && r.gpu !== filterGpu.value) return false;
    if (filterModel.value && r.model !== filterModel.value) return false;
    if (filterPod.value && r.url_id !== filterPod.value) return false;
    return true;
  });
}

function render() {
  const data = getFiltered();
  const rounds = data.filter((r) => r.type === "round");
  const summaries = data.filter((r) => r.type === "summary");

  renderOverview(rounds, summaries);
  renderGpuChart(rounds);
  renderModelChart(rounds);
  renderWarmup(rounds);
  renderSessions(summaries);
  renderRounds(rounds);
}

// ---------- Overview ----------
function renderOverview(rounds, summaries) {
  if (rounds.length === 0) {
    overviewGrid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No benchmark data yet. Run a benchmark first.</div>';
    return;
  }

  const totalRounds = rounds.length;
  const totalSessions = summaries.length;
  const avgTps = (rounds.reduce((s, r) => s + r.tps, 0) / totalRounds).toFixed(2);
  const avgTtft = (rounds.reduce((s, r) => s + r.ttft_s, 0) / totalRounds).toFixed(3);

  overviewGrid.innerHTML = `
    <div class="overview-card blue">
      <div class="value">${totalSessions}</div>
      <div class="label">Sessions</div>
    </div>
    <div class="overview-card purple">
      <div class="value">${totalRounds}</div>
      <div class="label">Total Rounds</div>
    </div>
    <div class="overview-card green">
      <div class="value">${avgTps}</div>
      <div class="label">Avg TPS</div>
    </div>
    <div class="overview-card yellow">
      <div class="value">${avgTtft}s</div>
      <div class="label">Avg TTFT</div>
    </div>
  `;
}

// ---------- GPU Comparison ----------
function renderGpuChart(rounds) {
  const byGpu = groupBy(rounds, "gpu");
  const entries = Object.entries(byGpu).map(([gpu, rows]) => ({
    label: gpu,
    value: rows.reduce((s, r) => s + r.tps, 0) / rows.length,
  }));
  entries.sort((a, b) => b.value - a.value);
  renderBarChart(gpuChart, entries, "blue");
}

// ---------- Model Comparison ----------
function renderModelChart(rounds) {
  const byModel = groupBy(rounds, "model");
  const entries = Object.entries(byModel).map(([model, rows]) => ({
    label: model,
    value: rows.reduce((s, r) => s + r.tps, 0) / rows.length,
  }));
  entries.sort((a, b) => b.value - a.value);
  renderBarChart(modelChart, entries, "green");
}

function renderBarChart(container, entries, color) {
  if (entries.length === 0) {
    container.innerHTML = '<div class="empty-state">No data</div>';
    return;
  }
  const max = Math.max(...entries.map((e) => e.value), 1);
  container.innerHTML = entries
    .map(
      (e) => `
    <div class="bar-row">
      <span class="bar-label" title="${e.label}">${e.label}</span>
      <div class="bar-track">
        <div class="bar-fill ${color}" style="width:${(e.value / max) * 100}%"></div>
      </div>
      <span class="bar-value">${e.value.toFixed(2)} t/s</span>
    </div>
  `
    )
    .join("");
}

// ---------- Warm-up Curve ----------
function renderWarmup(rounds) {
  // Group by gpu+model+url_id+timestamp (one session)
  const sessions = groupBy(rounds, (r) => `${r.gpu}|${r.model}|${r.url_id}|${r.timestamp}`);
  const sessionList = Object.entries(sessions)
    .map(([key, rows]) => {
      const [gpu, model, url_id] = key.split("|");
      return { gpu, model, url_id, timestamp: rows[0].timestamp, rows };
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 10); // last 10 sessions

  if (sessionList.length === 0) {
    warmupChart.innerHTML = '<div class="empty-state">No data</div>';
    return;
  }

  const globalMax = Math.max(...rounds.map((r) => r.tps), 1);

  warmupChart.innerHTML = sessionList
    .map((s) => {
      const bars = s.rows
        .map(
          (r, i) =>
            `<div class="warmup-bar" style="height:${(r.tps / globalMax) * 100}%" data-tip="R${i + 1}: ${r.tps.toFixed(2)} t/s"></div>`
        )
        .join("");
      return `
      <div class="warmup-pod">
        <div class="warmup-pod-header">
          <strong>${s.gpu}</strong> / ${s.model} / ${s.url_id} <span style="color:#484f58">${s.timestamp}</span>
        </div>
        <div class="warmup-dots">${bars}</div>
      </div>
    `;
    })
    .join("");
}

// ---------- Sessions Table ----------
function renderSessions(summaries) {
  const sorted = [...summaries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  sessionsBody.innerHTML = sorted
    .map(
      (r) => `
    <tr>
      <td>${r.timestamp}</td>
      <td>${r.gpu}</td>
      <td>${r.model}</td>
      <td>${r.url_id}</td>
      <td>${r.ttft_s.toFixed(3)}s</td>
      <td>${r.tps.toFixed(2)}</td>
      <td>${r.total_time_s.toFixed(3)}s</td>
    </tr>
  `
    )
    .join("");

  if (sorted.length === 0) {
    sessionsBody.innerHTML = '<tr><td colspan="7" class="empty-state">No sessions</td></tr>';
  }
}

// ---------- Rounds Table (paginated) ----------
let _sortedRounds = [];

function renderRounds(rounds) {
  _sortedRounds = [...rounds].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  roundCount.textContent = `${_sortedRounds.length} rounds`;
  roundsPage = 1;
  renderRoundsPage();
}

function renderRoundsPage() {
  const total = _sortedRounds.length;
  const totalPages = Math.max(1, Math.ceil(total / ROUNDS_PER_PAGE));
  if (roundsPage > totalPages) roundsPage = totalPages;

  const start = (roundsPage - 1) * ROUNDS_PER_PAGE;
  const page = _sortedRounds.slice(start, start + ROUNDS_PER_PAGE);

  roundsBody.innerHTML = page
    .map(
      (r) => `
    <tr>
      <td>${r.timestamp}</td>
      <td>${r.gpu}</td>
      <td>${r.model}</td>
      <td>${r.url_id}</td>
      <td>${r.round}</td>
      <td>${r.ttft_s.toFixed(3)}s</td>
      <td>${r.tps.toFixed(2)}</td>
      <td>${r.total_tokens}</td>
      <td>${r.total_time_s.toFixed(3)}s</td>
    </tr>
  `
    )
    .join("");

  if (total === 0) {
    roundsBody.innerHTML = '<tr><td colspan="9" class="empty-state">No rounds</td></tr>';
  }

  // Paging buttons
  roundsPaging.innerHTML = "";
  if (totalPages <= 1) return;

  const prevBtn = document.createElement("button");
  prevBtn.textContent = "Prev";
  prevBtn.disabled = roundsPage === 1;
  prevBtn.addEventListener("click", () => { roundsPage--; renderRoundsPage(); });
  roundsPaging.appendChild(prevBtn);

  const maxButtons = 7;
  let startPage = Math.max(1, roundsPage - Math.floor(maxButtons / 2));
  let endPage = Math.min(totalPages, startPage + maxButtons - 1);
  if (endPage - startPage < maxButtons - 1) startPage = Math.max(1, endPage - maxButtons + 1);

  for (let p = startPage; p <= endPage; p++) {
    const btn = document.createElement("button");
    btn.textContent = p;
    if (p === roundsPage) btn.className = "active";
    btn.addEventListener("click", () => { roundsPage = p; renderRoundsPage(); });
    roundsPaging.appendChild(btn);
  }

  const nextBtn = document.createElement("button");
  nextBtn.textContent = "Next";
  nextBtn.disabled = roundsPage === totalPages;
  nextBtn.addEventListener("click", () => { roundsPage++; renderRoundsPage(); });
  roundsPaging.appendChild(nextBtn);
}

// ---------- Utility ----------
function groupBy(arr, keyFn) {
  const fn = typeof keyFn === "function" ? keyFn : (r) => r[keyFn];
  const groups = {};
  arr.forEach((item) => {
    const k = fn(item);
    if (!groups[k]) groups[k] = [];
    groups[k].push(item);
  });
  return groups;
}
