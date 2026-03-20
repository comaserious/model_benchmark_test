const API_BASE = 'http://localhost:8000';

const form = document.getElementById("benchmarkForm");
const runBtn = document.getElementById("runBtn");
const statusCard = document.getElementById("statusCard");
const statusText = document.getElementById("statusText");
const summaryCard = document.getElementById("summaryCard");
const summaryInfo = document.getElementById("summaryInfo");
const summaryMetrics = document.getElementById("summaryMetrics");
const roundsCard = document.getElementById("roundsCard");
const roundsBody = document.getElementById("roundsBody");
const historyList = document.getElementById("historyList");

// Stored history (session only)
const history = [];

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await runBenchmark();
});

async function runBenchmark() {
  const urlId = document.getElementById("urlId").value.trim();
  const gpu = document.getElementById("gpu").value;
  const rounds = parseInt(document.getElementById("rounds").value) || 3;
  const maxTokens = parseInt(document.getElementById("maxTokens").value) || 256;

  if (!urlId || !gpu) return;

  // UI: loading
  runBtn.disabled = true;
  statusCard.classList.remove("hidden");
  statusText.textContent = "Running benchmark...";
  summaryCard.classList.add("hidden");
  roundsCard.classList.add("hidden");

  try {
    const res = await fetch(`${API_BASE}/benchmark`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url_id: urlId,
        gpu: gpu,
        rounds: rounds,
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    statusCard.classList.add("hidden");
    renderResults(data);
    addHistory(data);
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
    statusCard.classList.remove("hidden");
    statusCard.classList.add("error-card");
    setTimeout(() => statusCard.classList.remove("error-card"), 3000);
  } finally {
    runBtn.disabled = false;
  }
}

function renderResults(data) {
  const podBadge = data.is_new_pod
    ? '<span class="summary-tag tag-new">NEW POD</span>'
    : '<span class="summary-tag tag-existing">EXISTING POD</span>';

  summaryInfo.innerHTML = `
    <span class="summary-tag"><strong>${data.gpu}</strong></span>
    <span class="summary-tag"><strong>${data.model}</strong></span>
    ${podBadge}
    <span class="summary-tag">${data.url_id}</span>
    <span class="summary-tag">${data.rounds.length} rounds</span>
  `;

  if (data.summary) {
    const s = data.summary;
    summaryMetrics.innerHTML = `
      <div class="metric-box highlight-green">
        <div class="value">${s.avg_ttft_s.toFixed(3)}s</div>
        <div class="label">Avg TTFT</div>
      </div>
      <div class="metric-box highlight-blue">
        <div class="value">${s.avg_tps.toFixed(2)}</div>
        <div class="label">Avg TPS</div>
      </div>
      <div class="metric-box highlight-yellow">
        <div class="value">${s.avg_total_time_s.toFixed(3)}s</div>
        <div class="label">Avg Total</div>
      </div>
    `;
    summaryCard.classList.remove("hidden");
  }

  // Rounds table
  roundsBody.innerHTML = "";
  data.rounds.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${r.ttft_s.toFixed(3)}</td>
      <td>${r.tps.toFixed(2)}</td>
      <td>${r.total_tokens}</td>
      <td>${r.total_time_s.toFixed(3)}</td>
    `;
    roundsBody.appendChild(tr);
  });

  if (data.rounds.length > 0) {
    roundsCard.classList.remove("hidden");
  }
}

function addHistory(data) {
  if (!data.summary) return;

  history.unshift(data);
  renderHistory();
}

function renderHistory() {
  historyList.innerHTML = "";

  history.forEach((data) => {
    const s = data.summary;
    const div = document.createElement("div");
    div.className = "history-item";
    const badge = data.is_new_pod ? "NEW" : "EXISTING";
    const badgeClass = data.is_new_pod ? "tag-new" : "tag-existing";
    div.innerHTML = `
      <div class="meta">
        <strong>${data.gpu}</strong> / ${data.model}
        <span class="history-badge ${badgeClass}">${badge}</span>
        <span class="history-pod-id">${data.url_id}</span>
      </div>
      <div class="stats">
        <span>TTFT <span class="val">${s.avg_ttft_s.toFixed(3)}s</span></span>
        <span>TPS <span class="val">${s.avg_tps.toFixed(2)}</span></span>
        <span>Total <span class="val">${s.avg_total_time_s.toFixed(3)}s</span></span>
      </div>
    `;
    historyList.appendChild(div);
  });
}
