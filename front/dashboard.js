const API_BASE = "http://localhost:8000";

const filterGpu = document.getElementById("filterGpu");
const filterModel = document.getElementById("filterModel");
const filterPod = document.getElementById("filterPod");
const matrixWrap = document.getElementById("matrixWrap");
const coldStartChart = document.getElementById("coldStartChart");
const stabilityChart = document.getElementById("stabilityChart");
const sessionsBody = document.getElementById("sessionsBody");

let allData = [];

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
    matrixWrap.innerHTML = `<div class="empty-state">Failed to load: ${err.message}</div>`;
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

function onFilterChange() { render(); }

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

  renderMatrix(rounds);
  renderColdStart(rounds);
  renderStability(rounds);
  renderSessions(summaries, rounds);
}

// ===== GPU x Model Matrix =====
function renderMatrix(rounds) {
  if (rounds.length === 0) {
    matrixWrap.innerHTML = '<div class="empty-state">No benchmark data yet.</div>';
    return;
  }

  const gpus = [...new Set(rounds.map((r) => r.gpu))].sort();
  const models = [...new Set(rounds.map((r) => r.model))].sort();

  // Build stats per gpu+model
  const stats = {};
  rounds.forEach((r) => {
    const key = `${r.gpu}|${r.model}`;
    if (!stats[key]) stats[key] = { tpsSum: 0, ttftSum: 0, count: 0, sessions: new Set() };
    stats[key].tpsSum += r.tps;
    stats[key].ttftSum += r.ttft_s;
    stats[key].count++;
    stats[key].sessions.add(r.timestamp);
  });

  // Calculate averages
  const cells = {};
  let allTps = [];
  Object.entries(stats).forEach(([key, s]) => {
    const avgTps = s.tpsSum / s.count;
    const avgTtft = s.ttftSum / s.count;
    cells[key] = { avgTps, avgTtft, count: s.count, sessions: s.sessions.size };
    allTps.push(avgTps);
  });

  const maxTps = Math.max(...allTps);
  const minTps = Math.min(...allTps);

  // Determine cell class
  Object.values(cells).forEach((c) => {
    if (allTps.length <= 1) {
      c.cls = "only";
    } else if (c.avgTps === maxTps) {
      c.cls = "best";
    } else if (c.avgTps === minTps) {
      c.cls = "worst";
    } else {
      c.cls = "mid";
    }
  });

  let html = '<table class="matrix-table"><thead><tr><th></th>';
  models.forEach((m) => { html += `<th>${m}</th>`; });
  html += "</tr></thead><tbody>";

  gpus.forEach((gpu) => {
    html += `<tr><th>${gpu}</th>`;
    models.forEach((model) => {
      const key = `${gpu}|${model}`;
      const c = cells[key];
      if (c) {
        html += `<td class="matrix-cell ${c.cls}">
          <div class="tps">${c.avgTps.toFixed(2)}</div>
          <div class="ttft">TTFT ${c.avgTtft.toFixed(3)}s</div>
          <div class="sessions">${c.sessions} sessions / ${c.count} rounds</div>
        </td>`;
      } else {
        html += '<td class="matrix-cell empty">-</td>';
      }
    });
    html += "</tr>";
  });

  html += "</tbody></table>";
  matrixWrap.innerHTML = html;
}

// ===== Cold Start Analysis =====
function renderColdStart(rounds) {
  // Group by gpu+model
  const groups = groupBy(rounds, (r) => `${r.gpu}|${r.model}`);
  const items = Object.entries(groups).map(([key, rows]) => {
    const [gpu, model] = key.split("|");
    const round1 = rows.filter((r) => r.round === 1 || r.round === "1");
    const stable = rows.filter((r) => {
      const n = parseInt(r.round);
      return !isNaN(n) && n >= 3;
    });

    const r1Ttft = round1.length > 0 ? round1.reduce((s, r) => s + r.ttft_s, 0) / round1.length : 0;
    const stableTtft = stable.length > 0 ? stable.reduce((s, r) => s + r.ttft_s, 0) / stable.length : 0;

    // Per-round average TTFT for flow chart
    const byRound = {};
    rows.forEach((r) => {
      const n = parseInt(r.round);
      if (isNaN(n)) return;
      if (!byRound[n]) byRound[n] = { sum: 0, count: 0 };
      byRound[n].sum += r.ttft_s;
      byRound[n].count++;
    });
    const roundAvgs = Object.entries(byRound)
      .map(([rn, d]) => ({ round: parseInt(rn), ttft: d.sum / d.count }))
      .sort((a, b) => a.round - b.round);

    return { gpu, model, r1Ttft, stableTtft, roundAvgs };
  });

  if (items.length === 0) {
    coldStartChart.innerHTML = '<div class="empty-state">No data</div>';
    return;
  }

  const maxTtft = Math.max(...items.flatMap((i) => i.roundAvgs.map((r) => r.ttft)), 0.1);

  coldStartChart.innerHTML = '<div class="cold-start-list">' + items.map((item) => {
    const barMax = Math.max(item.r1Ttft, item.stableTtft, 0.01);
    const improvement = item.r1Ttft > 0 ? ((item.r1Ttft - item.stableTtft) / item.r1Ttft * 100) : 0;
    const pctClass = improvement > 0 ? "good" : improvement < 0 ? "bad" : "";

    // TTFT flow bars
    const flowBars = item.roundAvgs.map((r) => {
      const pct = (r.ttft / maxTtft) * 100;
      const hue = Math.max(0, Math.min(120, (1 - r.ttft / maxTtft) * 120));
      return `<div class="ttft-bar" style="height:${Math.max(pct, 5)}%;background:hsl(${hue},60%,45%)" data-tip="R${r.round}: ${r.ttft.toFixed(3)}s"></div>`;
    }).join("");

    return `
      <div class="cold-start-item">
        <div class="cold-start-header"><strong>${item.gpu}</strong> / ${item.model}</div>
        <div class="cold-start-bars">
          <div class="cold-bar-group">
            <div class="cold-bar-label">Round 1 TTFT</div>
            <div class="cold-bar-track">
              <div class="cold-bar-fill round1" style="width:${(item.r1Ttft / barMax) * 100}%">${item.r1Ttft.toFixed(3)}s</div>
            </div>
          </div>
          <div class="cold-bar-group">
            <div class="cold-bar-label">Stable (R3+) TTFT</div>
            <div class="cold-bar-track">
              <div class="cold-bar-fill stable" style="width:${(item.stableTtft / barMax) * 100}%">${item.stableTtft.toFixed(3)}s</div>
            </div>
          </div>
        </div>
        <div class="cold-start-ttft-flow">${flowBars}</div>
        <div class="cold-start-improvement">
          Warm-up improvement: <span class="pct ${pctClass}">${improvement > 0 ? "-" : "+"}${Math.abs(improvement).toFixed(1)}%</span>
          TTFT after stabilization
        </div>
      </div>
    `;
  }).join("") + "</div>";
}

// ===== TPS Stability =====
function renderStability(rounds) {
  const groups = groupBy(rounds, (r) => `${r.gpu}|${r.model}`);
  const items = Object.entries(groups).map(([key, rows]) => {
    const [gpu, model] = key.split("|");
    const tpsValues = rows.map((r) => r.tps);
    const min = Math.min(...tpsValues);
    const max = Math.max(...tpsValues);
    const avg = tpsValues.reduce((s, v) => s + v, 0) / tpsValues.length;
    const spread = max - min;
    return { gpu, model, min, max, avg, spread };
  });

  if (items.length === 0) {
    stabilityChart.innerHTML = '<div class="empty-state">No data</div>';
    return;
  }

  items.sort((a, b) => a.spread - b.spread); // most stable first

  const globalMin = Math.min(...items.map((i) => i.min)) * 0.95;
  const globalMax = Math.max(...items.map((i) => i.max)) * 1.05;
  const range = globalMax - globalMin;

  stabilityChart.innerHTML = '<div class="stability-list">' + items.map((item) => {
    const leftPct = ((item.min - globalMin) / range) * 100;
    const widthPct = ((item.max - item.min) / range) * 100;
    const avgPct = ((item.avg - globalMin) / range) * 100;

    return `
      <div class="stability-row">
        <span class="stability-label" title="${item.gpu} / ${item.model}">${item.gpu} / ${item.model}</span>
        <div class="stability-track">
          <div class="stability-range" style="left:${leftPct}%;width:${Math.max(widthPct, 0.5)}%"></div>
          <div class="stability-avg" style="left:${avgPct}%"></div>
        </div>
        <span class="stability-values">
          ${item.min.toFixed(1)} ~ ${item.max.toFixed(1)}
          (avg <span class="avg-val">${item.avg.toFixed(2)}</span>,
          spread ${item.spread.toFixed(2)})
        </span>
      </div>
    `;
  }).join("") + "</div>";
}

// ===== Recent Sessions =====
function renderSessions(summaries, rounds) {
  // Compute overall avg TPS per gpu+model from rounds
  const gpuModelAvg = {};
  const groups = groupBy(rounds, (r) => `${r.gpu}|${r.model}`);
  Object.entries(groups).forEach(([key, rows]) => {
    gpuModelAvg[key] = rows.reduce((s, r) => s + r.tps, 0) / rows.length;
  });

  const sorted = [...summaries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  if (sorted.length === 0) {
    sessionsBody.innerHTML = '<tr><td colspan="7" class="empty-state">No sessions</td></tr>';
    return;
  }

  sessionsBody.innerHTML = sorted.map((r) => {
    const key = `${r.gpu}|${r.model}`;
    const overallAvg = gpuModelAvg[key] || r.tps;
    const delta = r.tps - overallAvg;
    let deltaClass, deltaText;
    if (Math.abs(delta) < 0.5) {
      deltaClass = "delta-neutral";
      deltaText = "~0";
    } else if (delta > 0) {
      deltaClass = "delta-positive";
      deltaText = `+${delta.toFixed(2)}`;
    } else {
      deltaClass = "delta-negative";
      deltaText = delta.toFixed(2);
    }

    return `
      <tr>
        <td>${r.timestamp}</td>
        <td>${r.gpu}</td>
        <td>${r.model}</td>
        <td>${r.url_id}</td>
        <td>${r.ttft_s.toFixed(3)}s</td>
        <td>${r.tps.toFixed(2)}</td>
        <td class="${deltaClass}">${deltaText}</td>
      </tr>
    `;
  }).join("");
}

// ===== Utility =====
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
