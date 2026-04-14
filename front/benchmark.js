const API_BASE = 'http://localhost:8000';

const form = document.getElementById("benchmarkForm");
const runBtn = document.getElementById("runBtn");
const modeInput = document.getElementById("mode");
const runpodFields = document.getElementById("runpodFields");
const apiFields = document.getElementById("apiFields");
const statusCard = document.getElementById("statusCard");
const statusText = document.getElementById("statusText");
const progressWrap = document.getElementById("progressWrap");
const progressFill = document.getElementById("progressFill");
const progressLabel = document.getElementById("progressLabel");
const liveRounds = document.getElementById("liveRounds");
const summaryCard = document.getElementById("summaryCard");
const summaryInfo = document.getElementById("summaryInfo");
const summaryMetrics = document.getElementById("summaryMetrics");
const roundsCard = document.getElementById("roundsCard");
const roundsBody = document.getElementById("roundsBody");
const historyList = document.getElementById("historyList");

const history = [];

// Mode toggle
document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const mode = btn.dataset.mode;
    modeInput.value = mode;
    runpodFields.classList.toggle("hidden", mode !== "runpod");
    apiFields.classList.toggle("hidden", mode !== "api");
  });
});

// Provider preset
document.getElementById("provider").addEventListener("change", (e) => {
  const presets = {
    OpenAI: "https://api.openai.com",
    Google: "https://generativelanguage.googleapis.com",
    Custom: "",
  };
  const base = document.getElementById("apiBase");
  if (presets[e.target.value] !== undefined) {
    base.value = presets[e.target.value];
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await runBenchmark();
});

async function runBenchmark() {
  const mode = modeInput.value;
  const rounds = parseInt(document.getElementById("rounds").value) || 3;
  const maxTokens = parseInt(document.getElementById("maxTokens").value) || 256;

  let body = { mode, rounds, max_tokens: maxTokens };

  if (mode === "runpod") {
    const urlId = document.getElementById("urlId").value.trim();
    const gpu = document.getElementById("gpu").value;
    if (!urlId || !gpu) return;
    body.url_id = urlId;
    body.gpu = gpu;
  } else {
    const provider = document.getElementById("provider").value;
    const apiModel = document.getElementById("apiModel").value.trim();
    const apiBase = document.getElementById("apiBase").value.trim();
    const apiKey = document.getElementById("apiKey").value.trim();
    if (!apiModel || !apiBase || !apiKey) return;
    body.provider = provider;
    body.model = apiModel;
    body.api_base = apiBase;
    body.api_key = apiKey;
  }

  // Reset UI
  runBtn.disabled = true;
  statusCard.classList.remove("hidden", "error-card");
  statusText.textContent = mode === "runpod" ? "Connecting to pod..." : "Connecting to API...";
  progressWrap.classList.add("hidden");
  progressFill.style.width = "0%";
  progressLabel.textContent = "";
  liveRounds.classList.add("hidden");
  liveRounds.innerHTML = "";
  summaryCard.classList.add("hidden");
  roundsCard.classList.add("hidden");

  try {
    const res = await fetch(`${API_BASE}/benchmark`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = JSON.parse(line.slice(6));
        handleEvent(data);
        if (data.event === "done") finalData = data;
        if (data.event === "error") throw new Error(data.detail);
      }
    }

    if (buffer.startsWith("data: ")) {
      const data = JSON.parse(buffer.slice(6));
      handleEvent(data);
      if (data.event === "done") finalData = data;
    }

    statusCard.classList.add("hidden");
    if (finalData) {
      renderResults(finalData);
      addHistory(finalData);
    }
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
    statusCard.classList.remove("hidden");
    statusCard.classList.add("error-card");
  } finally {
    runBtn.disabled = false;
  }
}

function handleEvent(data) {
  switch (data.event) {
    case "start":
      statusText.textContent = `Benchmarking ${data.model} on ${data.gpu}`;
      progressWrap.classList.remove("hidden");
      liveRounds.classList.remove("hidden");
      progressLabel.textContent = `0 / ${data.total_rounds}`;
      break;

    case "progress":
      statusText.textContent = data.status;
      break;

    case "round":
      updateProgress(data.current, data.total);
      addLiveRound(data);
      break;
  }
}

function updateProgress(current, total) {
  const pct = (current / total) * 100;
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = `${current} / ${total}`;
}

function addLiveRound(data) {
  const div = document.createElement("div");
  div.className = `live-round${data.success ? "" : " failed"}`;

  if (data.success) {
    div.innerHTML = `
      <span class="round-num">Round ${data.current}</span>
      <div class="round-stats">
        <span>TTFT <span class="val">${data.ttft_s.toFixed(3)}s</span></span>
        <span>TPS <span class="val">${data.tps.toFixed(2)}</span></span>
        <span>Tokens <span class="val">${data.total_tokens}</span></span>
        <span>Total <span class="val">${data.e2e_time_s.toFixed(3)}s</span></span>
      </div>
    `;
  } else {
    div.innerHTML = `
      <span class="round-num">Round ${data.current}</span>
      <span>Failed (no tokens)</span>
    `;
  }

  liveRounds.appendChild(div);
  liveRounds.scrollTop = liveRounds.scrollHeight;
}

function renderResults(data) {
  const podBadge = data.is_new_pod
    ? '<span class="summary-tag tag-new">NEW</span>'
    : '<span class="summary-tag tag-existing">EXISTING</span>';

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
        <div class="value">${s.avg_e2e_time_s.toFixed(3)}s</div>
        <div class="label">Avg E2E</div>
      </div>
    `;
    summaryCard.classList.remove("hidden");
  }

  roundsBody.innerHTML = "";
  data.rounds.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${r.ttft_s.toFixed(3)}</td>
      <td>${r.tps.toFixed(2)}</td>
      <td>${r.total_tokens}</td>
      <td>${r.e2e_time_s.toFixed(3)}</td>
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
        <span>Total <span class="val">${s.avg_e2e_time_s.toFixed(3)}s</span></span>
      </div>
    `;
    historyList.appendChild(div);
  });
}
