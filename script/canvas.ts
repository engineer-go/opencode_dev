import { Database } from "bun:sqlite"
import path from "path"
import os from "os"
import fs from "fs"

const PORT = Number(process.env.PORT || process.env.CANVAS_PORT || 4141)

const candidateDbPaths = [
  process.env.DB_PATH,
  "/data/opencode.db",
  "/data/opencode-dev.db",
  path.join(os.homedir(), ".local/share/opencode/opencode.db"),
  path.join(os.homedir(), ".local/share/opencode/opencode-dev.db"),
].filter(Boolean) as string[]

const findActiveDb = () => {
  for (const p of candidateDbPaths) {
    if (fs.existsSync(p)) return p
  }
  return candidateDbPaths[0]
}

function fetchSessionTurns(sessionId: string) {
  const dbPath = findActiveDb()
  if (!dbPath || !fs.existsSync(dbPath)) return []

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })

    const messages = db
      .query(
        `
      SELECT 
        m.id,
        m.time_created,
        json_extract(m.data, '$.role') as role,
        json_extract(m.data, '$.cost') as cost,
        json_extract(m.data, '$.tokens.input') as input,
        json_extract(m.data, '$.tokens.output') as output,
        json_extract(m.data, '$.tokens.reasoning') as reasoning,
        json_extract(m.data, '$.tokens.cache.read') as cache_read,
        json_extract(m.data, '$.tokens.total') as total
      FROM message m
      WHERE m.session_id = ?
      ORDER BY m.time_created ASC
    `,
      )
      .all(sessionId) as any[]

    const userMessages = messages.filter((m) => m.role === "user")
    const turns = []

    for (let i = 0; i < userMessages.length; i++) {
      const u = userMessages[i]
      const part = db
        .query(
          `SELECT data FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' LIMIT 1`,
        )
        .get(u.id) as any
      const text = part ? JSON.parse(part.data).text : ""

      const nextUserTime = i < userMessages.length - 1 ? userMessages[i + 1].time_created : Infinity
      const assistantMsgs = messages.filter(
        (m) => m.role === "assistant" && m.time_created >= u.time_created && m.time_created < nextUserTime,
      )

      let totalInput = 0
      let totalOutput = 0
      let totalReasoning = 0
      let totalCache = 0
      let totalCost = 0
      let steps = 0

      for (const a of assistantMsgs) {
        if (a.input || a.output || a.cache_read) {
          totalInput += a.input || 0
          totalOutput += a.output || 0
          totalReasoning += a.reasoning || 0
          totalCache += a.cache_read || 0
          totalCost += a.cost || 0
          steps++
        }
      }

      const totalProcessed = totalInput + totalCache
      const cacheRatio = totalProcessed > 0 ? Number(((totalCache / totalProcessed) * 100).toFixed(1)) : 0

      turns.push({
        turn: i + 1,
        userMessageId: u.id,
        promptSnippet: text ? text.slice(0, 140) : "(tool action / system)",
        fullPrompt: text || "",
        steps,
        tokensInput: totalInput,
        tokensOutput: totalOutput,
        tokensReasoning: totalReasoning,
        tokensCacheRead: totalCache,
        cacheRatio,
        cost: Number(totalCost.toFixed(4)),
        timeCreated: u.time_created,
      })
    }

    return turns
  } catch (err) {
    console.error("fetchSessionTurns error:", err)
    return []
  } finally {
    if (db) db.close()
  }
}

function fetchMetrics() {
  const dbPath = findActiveDb()
  if (!dbPath || !fs.existsSync(dbPath)) {
    return {
      overview: {
        totalSessions: 0,
        totalCost: 0,
        totalModelCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalReasoningTokens: 0,
        avgCostPerCall: 0,
        avgInputPerCall: 0,
        cacheRatioPercent: 0,
      },
      sessions: [],
      toolStats: {},
      dbPath: dbPath || "not found",
      timestamp: Date.now(),
    }
  }

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })

    const sessions = db
      .query(
        `
      SELECT 
        s.id,
        s.title,
        s.cost,
        s.tokens_input,
        s.tokens_output,
        s.tokens_reasoning,
        s.tokens_cache_read,
        s.tokens_cache_write,
        s.time_created,
        s.time_updated,
        COUNT(p.id) as model_calls
      FROM session s
      LEFT JOIN part p ON p.session_id = s.id AND instr(p.data, '"type":"step-finish"') > 0
      GROUP BY s.id
      ORDER BY s.time_created DESC
    `,
      )
      .all() as any[]

    const toolRows = db
      .query(
        `
      SELECT 
        session_id,
        json_extract(data, '$.tool') as tool_name,
        COUNT(*) as count
      FROM part
      WHERE json_extract(data, '$.type') = 'tool'
      GROUP BY session_id, tool_name
    `,
      )
      .all() as any[]

    const sessionTools: Record<string, Record<string, number>> = {}
    const toolStats: Record<string, number> = {}

    for (const row of toolRows) {
      if (!row.tool_name) continue
      if (!sessionTools[row.session_id]) sessionTools[row.session_id] = {}
      sessionTools[row.session_id][row.tool_name] = row.count
      toolStats[row.tool_name] = (toolStats[row.tool_name] || 0) + row.count
    }

    let totalCost = 0
    let totalModelCalls = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadTokens = 0
    let totalReasoningTokens = 0

    const enrichedSessions = sessions.map((s) => {
      const calls = Math.max(1, s.model_calls || 0)
      const cost = s.cost || 0
      const input = s.tokens_input || 0
      const output = s.tokens_output || 0
      const cacheRead = s.tokens_cache_read || 0
      const reasoning = s.tokens_reasoning || 0

      totalCost += cost
      totalModelCalls += s.model_calls || 0
      totalInputTokens += input
      totalOutputTokens += output
      totalCacheReadTokens += cacheRead
      totalReasoningTokens += reasoning

      const costPerCall = Number((cost / calls).toFixed(4))
      const inputPerCall = Math.round(input / calls)
      const totalTurnTokens = input + cacheRead
      const cacheRatio = totalTurnTokens > 0 ? Number(((cacheRead / totalTurnTokens) * 100).toFixed(1)) : 0

      return {
        id: s.id,
        title: s.title || "Untitled Session",
        cost: Number(cost.toFixed(4)),
        modelCalls: s.model_calls || 0,
        tokensInput: input,
        tokensOutput: output,
        tokensReasoning: reasoning,
        tokensCacheRead: cacheRead,
        costPerCall,
        inputPerCall,
        cacheRatio,
        tools: sessionTools[s.id] || {},
        timeCreated: s.time_created,
        timeUpdated: s.time_updated,
      }
    })

    const totalProcessed = totalInputTokens + totalCacheReadTokens
    const cacheRatioPercent = totalProcessed > 0 ? Number(((totalCacheReadTokens / totalProcessed) * 100).toFixed(1)) : 0
    const avgCostPerCall = totalModelCalls > 0 ? Number((totalCost / totalModelCalls).toFixed(4)) : 0
    const avgInputPerCall = totalModelCalls > 0 ? Math.round(totalInputTokens / totalModelCalls) : 0

    return {
      overview: {
        totalSessions: sessions.length,
        totalCost: Number(totalCost.toFixed(3)),
        totalModelCalls,
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadTokens,
        totalReasoningTokens,
        avgCostPerCall,
        avgInputPerCall,
        cacheRatioPercent,
      },
      sessions: enrichedSessions,
      toolStats,
      dbPath,
      timestamp: Date.now(),
    }
  } catch (err) {
    console.error("Database query error:", err)
    return {
      overview: {
        totalSessions: 0,
        totalCost: 0,
        totalModelCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalReasoningTokens: 0,
        avgCostPerCall: 0,
        avgInputPerCall: 0,
        cacheRatioPercent: 0,
      },
      sessions: [],
      toolStats: {},
      dbPath: dbPath || "error",
      timestamp: Date.now(),
    }
  } finally {
    if (db) db.close()
  }
}

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCode • Efficiency & Token Canvas</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --card-border: #30363d;
      --text: #c9d1d9;
      --text-bright: #f0f6fc;
      --text-muted: #8b949e;
      --accent-blue: #58a6ff;
      --accent-green: #3fb950;
      --accent-purple: #bc8cff;
      --accent-amber: #d29922;
      --accent-red: #f85149;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 24px; min-height: 100vh; }
    
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--card-border); }
    h1 { font-size: 22px; color: var(--text-bright); display: flex; align-items: center; gap: 10px; font-weight: 600; }
    .status-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; background: rgba(63, 185, 80, 0.15); color: var(--accent-green); padding: 4px 10px; border-radius: 20px; font-weight: 500; }
    .status-badge.pulse::before { content: ""; width: 8px; height: 8px; background: var(--accent-green); border-radius: 50%; box-shadow: 0 0 8px var(--accent-green); animation: blink 1.5s infinite; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .kpi-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px; padding: 16px; transition: transform 0.2s; }
    .kpi-card:hover { transform: translateY(-2px); }
    .kpi-title { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    .kpi-value { font-size: 24px; font-weight: 700; color: var(--text-bright); }
    .kpi-sub { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

    .charts-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; margin-bottom: 24px; }
    @media (max-width: 900px) { .charts-grid { grid-template-columns: 1fr; } }
    .chart-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px; padding: 20px; }
    .chart-card h2 { font-size: 14px; color: var(--text-bright); margin-bottom: 16px; font-weight: 600; display: flex; justify-content: space-between; }
    .chart-box { height: 260px; position: relative; }

    .section-title { font-size: 16px; color: var(--text-bright); margin-bottom: 12px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
    .search-input { background: #0d1117; border: 1px solid var(--card-border); color: var(--text); padding: 6px 12px; border-radius: 6px; font-size: 13px; width: 260px; outline: none; }
    .search-input:focus { border-color: var(--accent-blue); }

    .table-container { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px; overflow-x: auto; max-height: 480px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
    th { position: sticky; top: 0; background: #21262d; color: var(--text-muted); font-size: 11px; text-transform: uppercase; padding: 12px 14px; font-weight: 600; border-bottom: 1px solid var(--card-border); z-index: 10; }
    td { padding: 12px 14px; border-bottom: 1px solid #21262d; white-space: nowrap; }
    tr:hover { background: rgba(255, 255, 255, 0.03); cursor: pointer; }
    .session-title-cell { max-width: 320px; overflow: hidden; text-overflow: ellipsis; font-weight: 500; color: var(--text-bright); }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; background: #21262d; }
    .badge-blue { color: var(--accent-blue); background: rgba(88, 166, 255, 0.1); }
    .badge-green { color: var(--accent-green); background: rgba(63, 185, 80, 0.1); }
    .badge-purple { color: var(--accent-purple); background: rgba(188, 140, 255, 0.1); }
    .badge-amber { color: var(--accent-amber); background: rgba(210, 153, 34, 0.1); }

    .drawer { position: fixed; top: 0; right: -750px; width: 700px; max-width: 92vw; height: 100vh; background: var(--card-bg); border-left: 1px solid var(--card-border); padding: 24px; box-shadow: -10px 0 40px rgba(0,0,0,0.6); transition: right 0.3s cubic-bezier(0.16, 1, 0.3, 1); z-index: 100; overflow-y: auto; }
    .drawer.open { right: 0; }
    .drawer-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--card-border); }
    .drawer-close { background: none; border: none; color: var(--text-muted); font-size: 24px; cursor: pointer; padding: 4px 8px; }
    .drawer-close:hover { color: var(--text-bright); }

    .tool-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; margin: 4px 4px 0 0; background: #21262d; border-radius: 6px; font-size: 11px; }

    .turns-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
    .turns-table th { background: #161b22; color: var(--text-muted); padding: 8px 10px; font-size: 10px; text-transform: uppercase; border-bottom: 1px solid var(--card-border); text-align: left; }
    .turns-table td { padding: 8px 10px; border-bottom: 1px solid #21262d; vertical-align: top; }
    .turns-prompt { max-width: 220px; word-break: break-word; color: var(--text-bright); font-weight: 500; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>OpenCode • Efficiency & Token Canvas</h1>
      <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">Real-time Telemetry & Optimization Impact Tracker</div>
    </div>
    <div style="display: flex; align-items: center; gap: 12px;">
      <span id="lastUpdated" style="font-size: 12px; color: var(--text-muted);">Syncing...</span>
      <span class="status-badge pulse" id="liveBadge">LIVE SYNC</span>
    </div>
  </header>

  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-title">Total Spend</div>
      <div class="kpi-value" id="kpiCost">$0.00</div>
      <div class="kpi-sub" id="kpiSessionsCount">0 total sessions</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Total Model Turns</div>
      <div class="kpi-value" id="kpiCalls">0</div>
      <div class="kpi-sub">LLM invocations</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Cost per Turn</div>
      <div class="kpi-value" id="kpiCostPerCall">$0.000</div>
      <div class="kpi-sub">Average across turns</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Input Tokens / Turn</div>
      <div class="kpi-value" id="kpiInputPerCall">0</div>
      <div class="kpi-sub">Context footprint</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Cache Hit Ratio</div>
      <div class="kpi-value" id="kpiCacheRatio">0%</div>
      <div class="kpi-sub" id="kpiCacheTokens">0 tokens cached</div>
    </div>
  </div>

  <div class="charts-grid">
    <div class="chart-card">
      <h2>
        <span>Turn Efficiency Trend (Cost & Input Tokens / Turn)</span>
        <span style="font-size: 11px; font-weight: normal; color: var(--text-muted);">Lower is faster & cheaper</span>
      </h2>
      <div class="chart-box">
        <canvas id="trendChart"></canvas>
      </div>
    </div>
    <div class="chart-card">
      <h2><span>Token Distribution</span></h2>
      <div class="chart-box">
        <canvas id="tokenPieChart"></canvas>
      </div>
    </div>
  </div>

  <div class="charts-grid">
    <div class="chart-card">
      <h2><span>Top Tools Usage Distribution</span></h2>
      <div class="chart-box">
        <canvas id="toolsChart"></canvas>
      </div>
    </div>
    <div class="chart-card">
      <h2><span>Active Session Footprint</span></h2>
      <div id="activeSessionBox" style="font-size: 13px; line-height: 1.6; color: var(--text-muted); padding-top: 10px;">
        Loading active session...
      </div>
    </div>
  </div>

  <div class="section-title">
    <span>All Recorded Sessions Matrix</span>
    <input type="text" id="searchInput" class="search-input" placeholder="Search sessions by title...">
  </div>

  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>Session Title</th>
          <th>Model Turns</th>
          <th>Total Cost</th>
          <th>Cost / Turn</th>
          <th>Input Tokens</th>
          <th>Output</th>
          <th>Cache Hit</th>
          <th>Top Tools</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody id="sessionsTableBody">
        <tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 24px;">Loading sessions...</td></tr>
      </tbody>
    </table>
  </div>

  <div id="detailDrawer" class="drawer">
    <div class="drawer-header">
      <div>
        <h3 id="drawerTitle" style="color: var(--text-bright); font-size: 16px; margin-bottom: 4px;">Session Details</h3>
        <span id="drawerId" style="font-size: 11px; color: var(--text-muted); word-break: break-all;"></span>
      </div>
      <button class="drawer-close" onclick="closeDrawer()">&times;</button>
    </div>
    <div id="drawerContent" style="display: flex; flex-direction: column; gap: 16px; font-size: 13px;"></div>
  </div>

  <script>
    let trendChart, tokenPieChart, toolsChart;
    let allSessions = [];

    function formatNumber(num) {
      return (num || 0).toLocaleString();
    }

    function formatDate(ts) {
      if (!ts) return "-";
      const d = new Date(ts);
      return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    async function loadData() {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        renderDashboard(data);
      } catch (e) {
        console.error("Failed to load metrics:", e);
      }
    }

    function renderDashboard(data) {
      document.getElementById('lastUpdated').textContent = "Updated " + new Date().toLocaleTimeString();
      const o = data.overview;
      document.getElementById('kpiCost').textContent = "$" + o.totalCost.toFixed(2);
      document.getElementById('kpiSessionsCount').textContent = o.totalSessions + " sessions tracked";
      document.getElementById('kpiCalls').textContent = formatNumber(o.totalModelCalls);
      document.getElementById('kpiCostPerCall').textContent = "$" + o.avgCostPerCall.toFixed(4);
      document.getElementById('kpiInputPerCall').textContent = formatNumber(o.avgInputPerCall);
      document.getElementById('kpiCacheRatio').textContent = o.cacheRatioPercent + "%";
      document.getElementById('kpiCacheTokens').textContent = formatNumber(o.totalCacheReadTokens) + " cached";

      allSessions = data.sessions || [];
      renderTable(allSessions);
      renderCharts(data);
      renderActiveSession(allSessions[0]);
    }

    function renderActiveSession(s) {
      const box = document.getElementById('activeSessionBox');
      if (!s) {
        box.innerHTML = "No sessions found.";
        return;
      }
      box.innerHTML = \`
        <div style="color: var(--text-bright); font-weight: 600; font-size: 14px; margin-bottom: 8px;">\${s.title}</div>
        <div style="margin-bottom: 4px;">• <b>Model Turns:</b> \${s.modelCalls} turns</div>
        <div style="margin-bottom: 4px;">• <b>Session Cost:</b> $\${s.cost.toFixed(4)} (avg $\${s.costPerCall.toFixed(4)}/turn)</div>
        <div style="margin-bottom: 4px;">• <b>Input Context:</b> \${formatNumber(s.tokensInput)} tokens (\${formatNumber(s.inputPerCall)}/turn)</div>
        <div style="margin-bottom: 4px;">• <b>Cache Reads:</b> \${formatNumber(s.tokensCacheRead)} tokens (\${s.cacheRatio}% hit rate)</div>
        <div style="margin-bottom: 12px;">• <b>Output / Reasoning:</b> \${formatNumber(s.tokensOutput)} / \${formatNumber(s.tokensReasoning)} tokens</div>
        <div style="color: var(--accent-green); font-size: 12px; font-weight: 500;">● Active session auto-refreshing in real time</div>
      \`;
    }

    function renderCharts(data) {
      const chronological = [...data.sessions].reverse().slice(-15);
      const labels = chronological.map(s => s.title.slice(0, 16) + '...');
      const costPerCall = chronological.map(s => s.costPerCall);
      const inputPerCall = chronological.map(s => s.inputPerCall);

      // Trend Chart
      if (trendChart) trendChart.destroy();
      trendChart = new Chart(document.getElementById('trendChart'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Cost / Turn ($)',
              data: costPerCall,
              borderColor: '#58a6ff',
              backgroundColor: 'rgba(88, 166, 255, 0.1)',
              yAxisID: 'yCost',
              tension: 0.3,
              fill: true
            },
            {
              label: 'Input Tokens / Turn',
              data: inputPerCall,
              borderColor: '#3fb950',
              borderDash: [5, 5],
              yAxisID: 'yTokens',
              tension: 0.3
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { labels: { color: '#8b949e', font: { size: 11 } } } },
          scales: {
            x: { ticks: { color: '#8b949e', maxRotation: 30, font: { size: 10 } }, grid: { color: '#21262d' } },
            yCost: { type: 'linear', position: 'left', ticks: { color: '#58a6ff' }, grid: { color: '#21262d' } },
            yTokens: { type: 'linear', position: 'right', ticks: { color: '#3fb950' }, grid: { display: false } }
          }
        }
      });

      // Token Pie Chart
      const o = data.overview;
      if (tokenPieChart) tokenPieChart.destroy();
      tokenPieChart = new Chart(document.getElementById('tokenPieChart'), {
        type: 'doughnut',
        data: {
          labels: ['Cached Input', 'Fresh Input', 'Output', 'Reasoning'],
          datasets: [{
            data: [o.totalCacheReadTokens, o.totalInputTokens, o.totalOutputTokens, o.totalReasoningTokens],
            backgroundColor: ['#3fb950', '#58a6ff', '#bc8cff', '#d29922'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { color: '#8b949e', font: { size: 11 } } } }
        }
      });

      // Tools Chart
      const toolPairs = Object.entries(data.toolStats || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
      if (toolsChart) toolsChart.destroy();
      toolsChart = new Chart(document.getElementById('toolsChart'), {
        type: 'bar',
        data: {
          labels: toolPairs.map(p => p[0]),
          datasets: [{
            label: 'Total Invocations',
            data: toolPairs.map(p => p[1]),
            backgroundColor: '#bc8cff',
            borderRadius: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#8b949e' }, grid: { display: false } },
            y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
          }
        }
      });
    }

    function renderTable(sessions) {
      const tbody = document.getElementById('sessionsTableBody');
      if (!sessions.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 24px;">No sessions found</td></tr>';
        return;
      }
      tbody.innerHTML = sessions.map(s => {
        const topTools = Object.entries(s.tools || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(p => p[0] + ' (' + p[1] + ')').join(', ') || '-';
        return \`
          <tr onclick="openDrawer('\${s.id}')">
            <td class="session-title-cell" title="\${s.title}">\${s.title}</td>
            <td><span class="badge badge-purple">\${s.modelCalls} turns</span></td>
            <td style="font-weight: 600; color: var(--text-bright); font-family: monospace;">$\${s.cost.toFixed(3)}</td>
            <td style="color: var(--accent-blue); font-family: monospace;">$\${s.costPerCall.toFixed(4)}</td>
            <td style="font-family: monospace;">\${formatNumber(s.tokensInput)}</td>
            <td style="font-family: monospace;">\${formatNumber(s.tokensOutput)}</td>
            <td><span class="badge badge-green">\${s.cacheRatio}%</span></td>
            <td style="color: var(--text-muted); font-size: 11px;">\${topTools}</td>
            <td style="color: var(--text-muted); font-size: 11px;">\${formatDate(s.timeCreated)}</td>
          </tr>
        \`;
      }).join('');
    }

    document.getElementById('searchInput').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      const filtered = allSessions.filter(s => s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
      renderTable(filtered);
    });

    let drawerChartInstance = null;

    async function openDrawer(id) {
      const s = allSessions.find(x => x.id === id);
      if (!s) return;
      document.getElementById('drawerTitle').textContent = s.title;
      document.getElementById('drawerId').textContent = "ID: " + s.id;
      
      const toolsHtml = Object.entries(s.tools || {}).map(([t, c]) => \`<span class="tool-chip"><b style="color: var(--accent-purple);">\${t}</b>: \${c}</span>\`).join('') || 'None';

      document.getElementById('drawerContent').innerHTML = \`
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="kpi-card">
            <div class="kpi-title">Session Cost</div>
            <div class="kpi-value">$\${s.cost.toFixed(4)}</div>
            <div class="kpi-sub">$\${s.costPerCall.toFixed(4)} avg / turn</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">Total Model Turns</div>
            <div class="kpi-value">\${s.modelCalls}</div>
            <div class="kpi-sub">\${formatNumber(s.inputPerCall)} input / turn</div>
          </div>
        </div>

        <div class="kpi-card">
          <div class="kpi-title">Token Footprint Breakdown</div>
          <div style="margin-top: 8px; font-size: 12px; line-height: 1.8; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <div>• Fresh Input: <b>\${formatNumber(s.tokensInput)}</b></div>
            <div>• Cache Read: <b style="color: var(--accent-green);">\${formatNumber(s.tokensCacheRead)}</b> (\${s.cacheRatio}%)</div>
            <div>• Output: <b>\${formatNumber(s.tokensOutput)}</b></div>
            <div>• Reasoning: <b>\${formatNumber(s.tokensReasoning)}</b></div>
          </div>
        </div>

        <div class="kpi-card">
          <div class="kpi-title">Tools Utilized</div>
          <div style="margin-top: 6px;">\${toolsHtml}</div>
        </div>

        <div class="kpi-card" style="padding: 16px;">
          <div class="kpi-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <span style="font-size: 13px; color: var(--text-bright); font-weight: 600;">Message-by-Message Token Flow</span>
            <span style="font-size: 11px; color: var(--accent-green);">● Live Turn Telemetry</span>
          </div>
          <div style="height: 180px; position: relative; margin-bottom: 14px;">
            <canvas id="drawerTurnsChart"></canvas>
          </div>
          <div id="drawerTurnsList" style="max-height: 280px; overflow-y: auto;">
            <div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 12px;">Loading message turns...</div>
          </div>
        </div>
      \`;

      document.getElementById('detailDrawer').classList.add('open');

      try {
        const res = await fetch('/api/session/' + id + '/turns');
        const turns = await res.json();
        renderDrawerTurns(turns);
      } catch (err) {
        console.error("Failed to load turns:", err);
      }
    }

    function renderDrawerTurns(turns) {
      const container = document.getElementById('drawerTurnsList');
      if (!turns || !turns.length) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 12px;">No individual message turns recorded yet.</div>';
        return;
      }

      // Render chart
      const ctx = document.getElementById('drawerTurnsChart');
      if (ctx) {
        if (drawerChartInstance) drawerChartInstance.destroy();
        drawerChartInstance = new Chart(ctx, {
          type: 'bar',
          data: {
            labels: turns.map(t => 'Turn #' + t.turn),
            datasets: [
              {
                label: 'Fresh Input',
                data: turns.map(t => t.tokensInput),
                backgroundColor: '#58a6ff',
                stack: 'tokens'
              },
              {
                label: 'Cached Read',
                data: turns.map(t => t.tokensCacheRead),
                backgroundColor: '#3fb950',
                stack: 'tokens'
              },
              {
                label: 'Output',
                data: turns.map(t => t.tokensOutput),
                backgroundColor: '#bc8cff',
                stack: 'tokens'
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: 'top', labels: { color: '#8b949e', font: { size: 10 }, boxWidth: 10 } }
            },
            scales: {
              x: { ticks: { color: '#8b949e', font: { size: 9 } }, grid: { display: false } },
              y: { ticks: { color: '#8b949e', font: { size: 9 } }, grid: { color: '#21262d' } }
            }
          }
        });
      }

      // Render Table
      container.innerHTML = \`
        <table class="turns-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Prompt</th>
              <th>Steps</th>
              <th>Fresh In</th>
              <th>Cached</th>
              <th>Out</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            \${turns.map(t => \`
              <tr>
                <td style="font-weight: 600; color: var(--accent-blue);">#\${t.turn}</td>
                <td class="turns-prompt" title="\${(t.fullPrompt || '').replace(/"/g, '&quot;')}">\${t.promptSnippet}</td>
                <td><span class="badge badge-purple">\${t.steps}</span></td>
                <td style="font-family: monospace;">\${formatNumber(t.tokensInput)}</td>
                <td style="font-family: monospace; color: var(--accent-green);">\${t.cacheRatio}%</td>
                <td style="font-family: monospace;">\${formatNumber(t.tokensOutput)}</td>
                <td style="font-family: monospace; font-weight: 600;">$\${t.cost.toFixed(4)}</td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      \`;
    }

    function closeDrawer() {
      document.getElementById('detailDrawer').classList.remove('open');
      if (drawerChartInstance) {
        drawerChartInstance.destroy();
        drawerChartInstance = null;
      }
    }

    // Auto-refresh every 2.5 seconds
    loadData();
    setInterval(loadData, 2500);
  </script>
</body>
</html>
`

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/api/stats") {
      const data = fetchMetrics()
      return Response.json(data, {
        headers: { "Access-Control-Allow-Origin": "*" },
      })
    }

    const turnsMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/turns$/)
    if (turnsMatch) {
      const turns = fetchSessionTurns(turnsMatch[1])
      return Response.json(turns, {
        headers: { "Access-Control-Allow-Origin": "*" },
      })
    }

    if (url.pathname === "/") {
      return new Response(htmlContent, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    return new Response("Not found", { status: 404 })
  },
})

console.log(`\n🚀 OpenCode Efficiency & Token Canvas is LIVE:`)
console.log(`👉 http://localhost:${server.port}\n`)
console.log(`Telemetry source: ${findActiveDb()}`)
console.log(`Auto-refreshing every 2.5s from SQLite journal.\n`)
