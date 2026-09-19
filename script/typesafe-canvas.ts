import path from "path"
import os from "os"
import fs from "fs"

const PORT = Number(process.env.TYPESAFE_CANVAS_PORT || process.env.PORT || 4142)

const candidateLogPaths = [
  process.env.TYPESAFE_LOG_PATH,
  path.join(os.homedir(), ".local/share/opencode/log/opencode.log"),
].filter(Boolean) as string[]

const findActiveLog = () => {
  for (const p of candidateLogPaths) {
    if (fs.existsSync(p)) return p
  }
  return candidateLogPaths[0]
}

interface TypeSafeCall {
  timestamp: string
  run: string
  source: string
  model: string
  questions: number
  status: number
  latency_ms: number
  input_tokens: number
  output_tokens: number
  error?: string
}

const tokenize = (line: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const re = /(\S+?)=("(?:[^"\\]|\\.)*"|\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(line)) !== null) {
    const key = match[1]
    let value = match[2]
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.slice(1, -1)
      }
    }
    out[key] = value
  }
  return out
}

const num = (value: string | undefined): number => {
  const parsed = Number(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

const fetchCalls = (): TypeSafeCall[] => {
  const logPath = findActiveLog()
  if (!logPath || !fs.existsSync(logPath)) return []
  const lines = fs.readFileSync(logPath, "utf8").split("\n")
  const calls: TypeSafeCall[] = []
  for (const line of lines) {
    if (!line.includes("typesafe_call")) continue
    const fields = tokenize(line)
    if (fields["message"] !== "typesafe_call") continue
    calls.push({
      timestamp: fields["timestamp"] ?? "",
      run: fields["run"] ?? "",
      source: fields["source"] ?? "unknown",
      model: fields["model"] ?? "unknown",
      questions: num(fields["questions"]),
      status: num(fields["status"]),
      latency_ms: num(fields["latency_ms"]),
      input_tokens: num(fields["input_tokens"]),
      output_tokens: num(fields["output_tokens"]),
      ...(fields["error"] ? { error: fields["error"] } : {}),
    })
  }
  return calls
}

interface FeatureStats {
  calls: number
  errors: number
  avgLatencyMs: number
  avgQuestions: number
  totalInputTokens: number
  totalOutputTokens: number
}

const fetchMetrics = () => {
  const calls = fetchCalls()
  const byFeature: Record<string, FeatureStats & { latencies: number[]; questionCounts: number[] }> = {}
  let errors = 0
  let latencySum = 0
  for (const call of calls) {
    const failed = call.status < 200 || call.status >= 300
    if (failed) errors++
    latencySum += call.latency_ms
    const entry = (byFeature[call.source] ??= {
      calls: 0,
      errors: 0,
      avgLatencyMs: 0,
      avgQuestions: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      latencies: [],
      questionCounts: [],
    })
    entry.calls++
    if (failed) entry.errors++
    entry.latencies.push(call.latency_ms)
    entry.questionCounts.push(call.questions)
    entry.totalInputTokens += call.input_tokens
    entry.totalOutputTokens += call.output_tokens
  }
  const features: Record<string, FeatureStats> = {}
  for (const [source, entry] of Object.entries(byFeature)) {
    const avg = (values: number[]) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0)
    features[source] = {
      calls: entry.calls,
      errors: entry.errors,
      avgLatencyMs: Math.round(avg(entry.latencies)),
      avgQuestions: Math.round(avg(entry.questionCounts) * 10) / 10,
      totalInputTokens: entry.totalInputTokens,
      totalOutputTokens: entry.totalOutputTokens,
    }
  }
  return {
    totalCalls: calls.length,
    totalErrors: errors,
    avgLatencyMs: calls.length > 0 ? Math.round(latencySum / calls.length) : 0,
    features,
    recent: calls.slice(-50).reverse(),
  }
}

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TypeSafe API Canvas</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 24px; }
  h1 { color: #58a6ff; font-size: 22px; margin: 0 0 4px; }
  .sub { color: #8b949e; font-size: 13px; margin-bottom: 20px; }
  .cards { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 18px; min-width: 140px; }
  .card .label { font-size: 12px; color: #8b949e; }
  .card .value { font-size: 24px; font-weight: 600; color: #3fb950; }
  .card .value.warn { color: #f0883e; }
  h2 { font-size: 16px; color: #58a6ff; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 500; }
  tr.ok td.status { color: #3fb950; }
  tr.err td.status { color: #f85149; }
  td.err-msg { color: #f0883e; max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chart-wrap { max-width: 720px; }
</style>
</head>
<body>
  <h1>TypeSafe API Canvas</h1>
  <div class="sub" id="sourceLine">Live view of <code>typesafe_call</code> records parsed from opencode.log &mdash; which feature called the API, how often, how fast, and what failed.</div>
  <div class="cards">
    <div class="card"><div class="label">Total calls</div><div class="value" id="totalCalls">0</div></div>
    <div class="card"><div class="label">Errors</div><div class="value warn" id="totalErrors">0</div></div>
    <div class="card"><div class="label">Avg latency</div><div class="value" id="avgLatency">0 ms</div></div>
    <div class="card"><div class="label">Features seen</div><div class="value" id="featureCount">0</div></div>
  </div>
  <h2>Calls by feature</h2>
  <div class="chart-wrap"><canvas id="featureChart"></canvas></div>
  <table id="featureTable"><thead><tr><th>Feature</th><th>Calls</th><th>Errors</th><th>Avg latency</th><th>Avg questions</th><th>Tokens in/out</th></tr></thead><tbody></tbody></table>
  <h2>Recent calls</h2>
  <table id="recentTable"><thead><tr><th>Time</th><th>Feature</th><th>Model</th><th>Q</th><th>Status</th><th>Latency</th><th>Tokens</th><th>Error</th></tr></thead><tbody></tbody></table>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    let featureChart;
    async function loadData() {
      const res = await fetch('/api/typesafe-calls');
      const data = await res.json();
      document.getElementById('totalCalls').textContent = data.totalCalls;
      document.getElementById('totalErrors').textContent = data.totalErrors;
      document.getElementById('avgLatency').textContent = data.avgLatencyMs + ' ms';
      document.getElementById('featureCount').textContent = Object.keys(data.features).length;

      const names = Object.keys(data.features).sort();
      const fbody = document.querySelector('#featureTable tbody');
      fbody.innerHTML = '';
      for (const name of names) {
        const f = data.features[name];
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + name + '</td><td>' + f.calls + '</td><td>' + f.errors + '</td><td>' + f.avgLatencyMs + ' ms</td><td>' + f.avgQuestions + '</td><td>' + f.totalInputTokens + ' / ' + f.totalOutputTokens + '</td>';
        fbody.appendChild(tr);
      }

      const rbody = document.querySelector('#recentTable tbody');
      rbody.innerHTML = '';
      for (const c of data.recent) {
        const ok = c.status >= 200 && c.status < 300;
        const tr = document.createElement('tr');
        tr.className = ok ? 'ok' : 'err';
        const time = c.timestamp ? c.timestamp.slice(11, 19) : '';
        tr.innerHTML = '<td>' + time + '</td><td>' + c.source + '</td><td>' + c.model + '</td><td>' + c.questions + '</td><td class="status">' + c.status + '</td><td>' + c.latency_ms + ' ms</td><td>' + c.input_tokens + ' / ' + c.output_tokens + '</td><td class="err-msg">' + (c.error || '') + '</td>';
        rbody.appendChild(tr);
      }

      if (featureChart) featureChart.destroy();
      featureChart = new Chart(document.getElementById('featureChart'), {
        type: 'bar',
        data: {
          labels: names,
          datasets: [
            { label: 'Calls', data: names.map(n => data.features[n].calls), backgroundColor: 'rgba(88, 166, 255, 0.85)' },
            { label: 'Errors', data: names.map(n => data.features[n].errors), backgroundColor: 'rgba(248, 81, 73, 0.85)' },
          ],
        },
        options: { plugins: { legend: { labels: { color: '#c9d1d9' } } }, scales: { x: { ticks: { color: '#8b949e' } }, y: { ticks: { color: '#8b949e' }, beginAtZero: true } } },
      });
    }
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

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 })
    }

    if (url.pathname === "/api/typesafe-calls") {
      const data = fetchMetrics()
      return Response.json(data, {
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

console.log(`\n🚀 TypeSafe API Canvas is LIVE:`)
console.log(`👉 http://localhost:${server.port}\n`)
console.log(`Records source: ${findActiveLog()}`)
console.log(`Auto-refreshing every 2.5s from opencode.log.\n`)
