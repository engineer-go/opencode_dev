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

const findAllDbs = () => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of candidateDbPaths) {
    if (!p || !fs.existsSync(p)) continue
    const real = fs.realpathSync(p)
    if (seen.has(real)) continue
    seen.add(real)
    out.push(p)
  }
  return out
}

const findActiveDb = () => {
  return findAllDbs()[0] ?? candidateDbPaths[0]
}

function fetchSessionTurns(sessionId: string) {
  const dbPaths = findAllDbs().filter((p) => p && fs.existsSync(p))
  if (!dbPaths.length) {
    return { turns: [], allSteps: [], summary: { totalCost: 0, totalTurns: 0, totalSteps: 0, avgCostPerTurn: 0, peakTurnCost: 0, peakTurnIndex: 0, cacheRatioPercent: 0 } }
  }

  // A session lives in exactly one DB (prod vs dev channel DBs use independent
  // uuids). Search each DB and use the first one that actually contains it,
  // so dev sessions are visible alongside prod sessions.
  for (const dbPath of dbPaths) {
    let db: Database | null = null
    try {
      db = new Database(dbPath, { readonly: true })

      const sessionExists = db.query(`SELECT 1 FROM session WHERE id = ? LIMIT 1`).get(sessionId)
      if (!sessionExists) continue

    const messages = db
      .query(
        `
      SELECT 
        m.id,
        m.time_created,
        json_extract(m.data, '$.role') as role,
        json_extract(m.data, '$.parentID') as parent_id,
        json_extract(m.data, '$.cost') as cost,
        json_extract(m.data, '$.tokens.input') as input,
        json_extract(m.data, '$.tokens.output') as output,
        json_extract(m.data, '$.tokens.reasoning') as reasoning,
        json_extract(m.data, '$.tokens.cache.read') as cache_read,
        json_extract(m.data, '$.finish') as finish,
        json_extract(m.data, '$.modelID') as model_id
      FROM message m
      WHERE m.session_id = ?
      ORDER BY m.time_created ASC
    `,
      )
      .all(sessionId) as any[]

    const toolParts = db
      .query(
        `
      SELECT message_id, json_extract(data, '$.tool') as tool_name
      FROM part
      WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'
    `,
      )
      .all(sessionId) as any[]

    const msgTools: Record<string, string[]> = {}
    for (const t of toolParts) {
      if (!msgTools[t.message_id]) msgTools[t.message_id] = []
      if (t.tool_name) msgTools[t.message_id].push(t.tool_name)
    }

    const userMessages = messages.filter((m) => m.role === "user")
    const assistantMessages = messages.filter((m) => m.role === "assistant")

    let totalSessionCost = 0
    let totalCacheReadTokens = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalReasoningTokens = 0

    for (const a of assistantMessages) {
      totalSessionCost += a.cost || 0
      totalCacheReadTokens += a.cache_read || 0
      totalInputTokens += a.input || 0
      totalOutputTokens += a.output || 0
      totalReasoningTokens += a.reasoning || 0
    }

    let runningCumulative = 0
    const turns = []
    let peakTurnCost = 0
    let peakTurnIndex = 1

    for (let i = 0; i < userMessages.length; i++) {
      const u = userMessages[i]
      const part = db
        .query(
          `SELECT data FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' LIMIT 1`,
        )
        .get(u.id) as any
      const text = part ? JSON.parse(part.data).text : ""

      const nextUserTime = i < userMessages.length - 1 ? userMessages[i + 1].time_created : Infinity
      const assts = assistantMessages.filter(
        (a) => a.parent_id === u.id || (a.time_created >= u.time_created && a.time_created < nextUserTime),
      )

      let tInput = 0, tOutput = 0, tReasoning = 0, tCache = 0, tCost = 0
      const tTools: Record<string, number> = {}
      const steps = []

      for (let sIdx = 0; sIdx < assts.length; sIdx++) {
        const a = assts[sIdx]
        const c = a.cost || 0
        const inp = a.input || 0
        const out = a.output || 0
        const reas = a.reasoning || 0
        const cach = a.cache_read || 0
        const tools = msgTools[a.id] || []

        tCost += c
        tInput += inp
        tOutput += out
        tReasoning += reas
        tCache += cach

        for (const t of tools) {
          tTools[t] = (tTools[t] || 0) + 1
        }

        const stepProc = inp + cach
        const stepCacheRatio = stepProc > 0 ? Number(((cach / stepProc) * 100).toFixed(1)) : 0

        steps.push({
          step: sIdx + 1,
          id: a.id,
          cost: Number(c.toFixed(4)),
          tokensInput: inp,
          tokensOutput: out,
          tokensReasoning: reas,
          tokensCacheRead: cach,
          cacheRatio: stepCacheRatio,
          tools,
          finish: a.finish || "",
          modelId: a.model_id || "",
        })
      }

      const startCost = Number(runningCumulative.toFixed(4))
      runningCumulative += tCost
      const endCost = Number(runningCumulative.toFixed(4))
      const processed = tInput + tCache
      const cacheRatio = processed > 0 ? Number(((tCache / processed) * 100).toFixed(1)) : 0
      const pctOfTotal = totalSessionCost > 0 ? Number(((tCost / totalSessionCost) * 100).toFixed(1)) : 0

      if (tCost > peakTurnCost) {
        peakTurnCost = tCost
        peakTurnIndex = i + 1
      }

      turns.push({
        turn: i + 1,
        userMessageId: u.id,
        promptSnippet: text ? text.slice(0, 140) : "(tool action / system)",
        fullPrompt: text || "",
        stepsCount: assts.length,
        cost: Number(tCost.toFixed(4)),
        startCost,
        endCost,
        cumulativeCost: endCost,
        percentOfTotal: pctOfTotal,
        tokensInput: tInput,
        tokensOutput: tOutput,
        tokensReasoning: tReasoning,
        tokensCacheRead: tCache,
        cacheRatio,
        tools: tTools,
        steps,
        timeCreated: u.time_created,
      })
    }

    // Flat list of individual model steps across the entire session
    let stepCumulative = 0
    const allSteps = []
    for (let idx = 0; idx < assistantMessages.length; idx++) {
      const a = assistantMessages[idx]
      const c = a.cost || 0
      const inp = a.input || 0
      const out = a.output || 0
      const reas = a.reasoning || 0
      const cach = a.cache_read || 0
      const tools = msgTools[a.id] || []
      const startCost = Number(stepCumulative.toFixed(4))
      stepCumulative += c
      const endCost = Number(stepCumulative.toFixed(4))
      const proc = inp + cach
      const cacheRatio = proc > 0 ? Number(((cach / proc) * 100).toFixed(1)) : 0
      const pctOfTotal = totalSessionCost > 0 ? Number(((c / totalSessionCost) * 100).toFixed(1)) : 0

      allSteps.push({
        step: idx + 1,
        id: a.id,
        parentId: a.parent_id,
        cost: Number(c.toFixed(4)),
        startCost,
        endCost,
        cumulativeCost: endCost,
        percentOfTotal: pctOfTotal,
        tokensInput: inp,
        tokensOutput: out,
        tokensReasoning: reas,
        tokensCacheRead: cach,
        cacheRatio,
        tools,
        finish: a.finish || "",
        modelId: a.model_id || "",
        timeCreated: a.time_created,
      })
    }

    const totalProcessed = totalInputTokens + totalCacheReadTokens
    const overallCacheRatio = totalProcessed > 0 ? Number(((totalCacheReadTokens / totalProcessed) * 100).toFixed(1)) : 0
    const avgCostPerTurn = turns.length > 0 ? Number((totalSessionCost / turns.length).toFixed(4)) : (allSteps.length > 0 ? Number((totalSessionCost / allSteps.length).toFixed(4)) : 0)

    const result = {
      turns,
      allSteps,
      summary: {
        totalCost: Number(totalSessionCost.toFixed(4)),
        totalTurns: turns.length,
        totalSteps: assistantMessages.length,
        avgCostPerTurn,
        peakTurnCost: Number(peakTurnCost.toFixed(4)),
        peakTurnIndex,
        cacheRatioPercent: overallCacheRatio,
        totalInputTokens,
        totalCacheReadTokens,
        totalOutputTokens,
        totalReasoningTokens,
      },
    }
    db.close()
    return result
    } catch (err) {
      console.error(`fetchSessionTurns error (${dbPath}):`, err)
      try {
        if (db) db.close()
      } catch {}
      continue
    } finally {
      try {
        if (db) db.close()
      } catch {}
    }
  }
  return {
    turns: [],
    allSteps: [],
    summary: { totalCost: 0, totalTurns: 0, totalSteps: 0, avgCostPerTurn: 0, peakTurnCost: 0, peakTurnIndex: 0, cacheRatioPercent: 0 },
  }
}

function fetchMetrics() {
  const dbPaths = findAllDbs().filter((p) => p && fs.existsSync(p))
  const emptyOverview = {
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
  }
  if (!dbPaths.length) {
    return {
      overview: emptyOverview,
      sessions: [],
      toolStats: {},
      dbPath: candidateDbPaths[0] || "not found",
      dbPaths: [] as string[],
      timestamp: Date.now(),
    }
  }

  // Merge prod + dev channel DBs (opencode.db, opencode-dev.db) into one view.
  // Session IDs are uuids, so collisions across DBs are not expected; if the
  // same id appears twice keep the row with the latest time_updated.
  const sessionById = new Map<string, any>()
  const sessionSource = new Map<string, string>()
  const toolRowsAll: { row: any; dbPath: string }[] = []

  for (const dbPath of dbPaths) {
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

      for (const s of sessions) {
        const prev = sessionById.get(s.id)
        if (!prev || (s.time_updated || 0) > (prev.time_updated || 0)) {
          sessionById.set(s.id, s)
          sessionSource.set(s.id, dbPath)
        }
      }

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
      for (const row of toolRows) toolRowsAll.push({ row, dbPath })
    } catch (err) {
      console.error(`Database query error (${dbPath}):`, err)
      continue
    } finally {
      try {
        if (db) db.close()
      } catch {}
    }
  }

  try {
    const sessions = [...sessionById.values()].sort((a, b) => (b.time_created || 0) - (a.time_created || 0))

    const sessionTools: Record<string, Record<string, number>> = {}
    const toolStats: Record<string, number> = {}

    for (const { row, dbPath: src } of toolRowsAll) {
      // For session ids present in both DBs, only count tools from the DB
      // that won the session dedup above. Otherwise identical sessions would
      // double-count tool invocations.
      if (sessionSource.has(row.session_id) && sessionSource.get(row.session_id) !== src) continue
      if (!row.tool_name) continue
      if (!sessionTools[row.session_id]) sessionTools[row.session_id] = {}
      sessionTools[row.session_id][row.tool_name] = (sessionTools[row.session_id][row.tool_name] || 0) + row.count
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
      dbPath: dbPaths[0],
      dbPaths,
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
      dbPath: dbPaths[0] || "error",
      dbPaths,
      timestamp: Date.now(),
    }
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

    .drawer { position: fixed; top: 0; right: -820px; width: 780px; max-width: 95vw; height: 100vh; background: var(--card-bg); border-left: 1px solid var(--card-border); padding: 24px; box-shadow: -10px 0 40px rgba(0,0,0,0.6); transition: right 0.3s cubic-bezier(0.16, 1, 0.3, 1); z-index: 100; overflow-y: auto; }
    .drawer.open { right: 0; }
    .drawer-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; padding-bottom: 14px; border-bottom: 1px solid var(--card-border); }
    .drawer-close { background: none; border: none; color: var(--text-muted); font-size: 24px; cursor: pointer; padding: 4px 8px; border-radius: 4px; line-height: 1; }
    .drawer-close:hover { color: var(--text-bright); background: rgba(255,255,255,0.06); }

    .tool-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; margin: 3px 4px 0 0; background: #21262d; border-radius: 6px; font-size: 11px; }

    .waterfall-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .btn-group { display: inline-flex; border-radius: 6px; overflow: hidden; border: 1px solid var(--card-border); background: #0d1117; }
    .btn-toggle { background: transparent; color: var(--text-muted); border: none; padding: 5px 10px; font-size: 11px; cursor: pointer; transition: all 0.15s; font-weight: 500; }
    .btn-toggle:hover { color: var(--text-bright); background: rgba(255,255,255,0.05); }
    .btn-toggle.active { background: #21262d; color: var(--text-bright); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent-blue); }

    .turns-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
    .turns-table th { position: sticky; top: 0; background: #161b22; color: var(--text-muted); padding: 8px 10px; font-size: 10px; text-transform: uppercase; border-bottom: 1px solid var(--card-border); text-align: left; z-index: 5; }
    .turns-table td { padding: 8px 10px; border-bottom: 1px solid #21262d; vertical-align: middle; }
    .turn-row { cursor: pointer; transition: background 0.15s; }
    .turn-row:hover { background: rgba(255, 255, 255, 0.04); }
    .turn-row.highlighted { background: rgba(88, 166, 255, 0.12) !important; }
    .turns-prompt { max-width: 240px; word-break: break-word; color: var(--text-bright); font-weight: 500; }

    .cost-bar-container { display: flex; align-items: center; gap: 6px; }
    .cost-progress { width: 36px; height: 5px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden; flex-shrink: 0; }
    .cost-progress-fill { height: 100%; background: var(--accent-blue); border-radius: 3px; }
    .cost-progress-fill.peak { background: var(--accent-amber); }

    .accordion-toggle { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; font-size: 10px; color: var(--text-muted); margin-right: 4px; transition: transform 0.2s; user-select: none; }
    .accordion-toggle.expanded { transform: rotate(90deg); color: var(--accent-blue); }
    
    .steps-subtable-container { background: #0d1117; padding: 8px 12px; border-left: 2px solid var(--accent-purple); margin: 4px 0 8px 16px; border-radius: 0 6px 6px 0; }
    .steps-subtable { width: 100%; border-collapse: collapse; font-size: 11px; }
    .steps-subtable th { background: transparent; padding: 4px 8px; font-size: 9px; color: var(--text-muted); text-transform: uppercase; border-bottom: 1px solid #21262d; }
    .steps-subtable td { padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,0.03); }
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
      const q = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
      const filtered = q ? allSessions.filter(s => s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) : allSessions;
      renderTable(filtered);
      renderCharts(data);
      renderActiveSession(allSessions[0]);

      // If drawer is currently open for the active session, refresh its waterfall turns quietly
      if (activeDrawerSessionId && allSessions.length > 0 && allSessions[0].id === activeDrawerSessionId) {
        refreshDrawerTurnsQuietly(activeDrawerSessionId);
      }
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
    let activeDrawerSessionId = null;
    let activeDrawerData = null;
    let activeDrawerSession = null;
    let waterfallChartMode = 'waterfall'; // 'waterfall' | 'spikes' | 'tokens'
    let waterfallGranularity = 'auto'; // 'auto' | 'turns' | 'steps'
    let expandedTurnIds = new Set();
    let drawerFilterText = '';

    function getToolColor(tool) {
      if (tool === 'bash') return '#58a6ff';
      if (tool === 'read') return '#bc8cff';
      if (tool === 'write' || tool === 'edit') return '#3fb950';
      if (tool === 'grep' || tool === 'glob') return '#d29922';
      if (tool === 'webfetch') return '#39c5bb';
      if (tool === 'question') return '#f85149';
      return '#8b949e';
    }

    async function openDrawer(id) {
      const s = allSessions.find(x => x.id === id);
      if (!s) return;
      activeDrawerSessionId = id;
      activeDrawerSession = s;
      expandedTurnIds.clear();
      drawerFilterText = '';

      document.getElementById('drawerTitle').textContent = s.title;
      document.getElementById('drawerId').textContent = "ID: " + s.id;
      document.getElementById('detailDrawer').classList.add('open');

      document.getElementById('drawerContent').innerHTML = \`
        <div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 40px 0;">
          <div style="display: inline-block; width: 24px; height: 24px; border: 2px solid var(--accent-blue); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 12px;"></div>
          <div>Loading turn waterfall & session telemetry...</div>
        </div>
      \`;

      try {
        const res = await fetch('/api/session/' + id + '/turns');
        const data = await res.json();
        activeDrawerData = data;
        renderFullDrawer();
      } catch (err) {
        console.error("Failed to load turns:", err);
        document.getElementById('drawerContent').innerHTML = '<div style="color: var(--accent-red); padding: 20px;">Failed to load turn telemetry.</div>';
      }
    }

    async function refreshDrawerTurnsQuietly(id) {
      try {
        const res = await fetch('/api/session/' + id + '/turns');
        const data = await res.json();
        activeDrawerData = data;
        const s = allSessions.find(x => x.id === id);
        if (s) activeDrawerSession = s;
        updateDrawerTelemetry();
      } catch (e) {}
    }

    function renderFullDrawer() {
      const s = activeDrawerSession;
      const data = activeDrawerData;
      if (!s || !data) return;

      const sm = data.summary || {};
      const turns = data.turns || [];
      const allSteps = data.allSteps || [];

      // Determine default granularity if auto
      const effectiveGranularity = waterfallGranularity === 'auto' 
        ? (turns.length > 1 ? 'turns' : 'steps') 
        : waterfallGranularity;

      const toolsHtml = Object.entries(s.tools || {}).map(([t, c]) => \`
        <span class="tool-chip" style="border-left: 2px solid \${getToolColor(t)};">
          <b style="color: \${getToolColor(t)};">\${t}</b>: \${c}
        </span>
      \`).join('') || '<span style="color: var(--text-muted);">None</span>';

      document.getElementById('drawerContent').innerHTML = \`
        <!-- KPI Row -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 8px;">
          <div class="kpi-card" style="padding: 12px;">
            <div class="kpi-title">Total Spend</div>
            <div class="kpi-value" style="font-size: 18px; color: var(--text-bright); font-family: monospace;">$\${(sm.totalCost || s.cost).toFixed(4)}</div>
            <div class="kpi-sub">$\${(sm.avgCostPerTurn || s.costPerCall).toFixed(4)} avg / turn</div>
          </div>
          <div class="kpi-card" style="padding: 12px;">
            <div class="kpi-title">Model Turns</div>
            <div class="kpi-value" style="font-size: 18px;">\${sm.totalTurns || turns.length} <span style="font-size: 11px; font-weight: normal; color: var(--text-muted);">(\${sm.totalSteps || allSteps.length} steps)</span></div>
            <div class="kpi-sub">\${formatNumber(s.inputPerCall)} in / turn</div>
          </div>
          <div class="kpi-card" style="padding: 12px;">
            <div class="kpi-title">Peak Cost Turn</div>
            <div class="kpi-value" style="font-size: 18px; color: var(--accent-amber); font-family: monospace;">$\${(sm.peakTurnCost || 0).toFixed(4)}</div>
            <div class="kpi-sub">Turn #\${sm.peakTurnIndex || 1} spike</div>
          </div>
          <div class="kpi-card" style="padding: 12px;">
            <div class="kpi-title">Cache Hit Ratio</div>
            <div class="kpi-value" style="font-size: 18px; color: var(--accent-green);">\${sm.cacheRatioPercent || s.cacheRatio}%</div>
            <div class="kpi-sub">\${formatNumber(sm.totalCacheReadTokens || s.tokensCacheRead)} cached</div>
          </div>
        </div>

        <!-- Tools Used -->
        <div class="kpi-card" style="padding: 12px;">
          <div class="kpi-title" style="margin-bottom: 6px;">Tools Utilized Across Session</div>
          <div>\${toolsHtml}</div>
        </div>

        <!-- Waterfall Visualizer Section -->
        <div class="kpi-card" style="padding: 16px;">
          <div class="waterfall-controls">
            <div>
              <div style="font-size: 14px; font-weight: 600; color: var(--text-bright); display: flex; align-items: center; gap: 8px;">
                <span>Per-Turn Cost Waterfall</span>
                <span style="font-size: 10px; background: rgba(88, 166, 255, 0.15); color: var(--accent-blue); padding: 2px 6px; border-radius: 4px; font-weight: 500;">Interactive</span>
              </div>
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Step-by-step cost accumulation and model turn dynamics</div>
            </div>

            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
              <!-- Granularity toggle if multiple user turns -->
              \${turns.length > 1 ? \`
                <div class="btn-group">
                  <button class="btn-toggle \${effectiveGranularity === 'turns' ? 'active' : ''}" onclick="setWaterfallGranularity('turns')">💬 User Turns (\${turns.length})</button>
                  <button class="btn-toggle \${effectiveGranularity === 'steps' ? 'active' : ''}" onclick="setWaterfallGranularity('steps')">⚙️ All Steps (\${allSteps.length})</button>
                </div>
              \` : ''}

              <!-- Chart Mode toggle -->
              <div class="btn-group">
                <button class="btn-toggle \${waterfallChartMode === 'waterfall' ? 'active' : ''}" onclick="setWaterfallMode('waterfall')" title="Financial cumulative staircase waterfall">🧗 Staircase ($)</button>
                <button class="btn-toggle \${waterfallChartMode === 'spikes' ? 'active' : ''}" onclick="setWaterfallMode('spikes')" title="Turn Cost bars + Cumulative spend line">📊 Cost & Trend</button>
                <button class="btn-toggle \${waterfallChartMode === 'tokens' ? 'active' : ''}" onclick="setWaterfallMode('tokens')" title="Fresh input, cached read, output tokens">⚡ Token Flow</button>
              </div>
            </div>
          </div>

          <div style="height: 220px; position: relative; margin-bottom: 12px; background: rgba(0,0,0,0.2); border-radius: 6px; padding: 8px;">
            <canvas id="drawerTurnsChart"></canvas>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); text-align: center;">
            💡 Click any bar on the chart to scroll to and inspect that turn in the table below.
          </div>
        </div>

        <!-- Turn-by-Turn Inspection Table -->
        <div class="kpi-card" style="padding: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
            <span style="font-size: 13px; font-weight: 600; color: var(--text-bright);">Detailed Turn-by-Turn Matrix</span>
            <input type="text" id="drawerTurnSearch" placeholder="Filter turns by prompt or tool..." oninput="onDrawerFilterInput(this.value)" class="search-input" style="width: 220px; font-size: 11px; padding: 4px 8px;">
          </div>
          <div id="drawerTurnsList" style="max-height: 380px; overflow-y: auto; border: 1px solid var(--card-border); border-radius: 6px;">
          </div>
        </div>
      \`;

      renderDrawerChart();
      renderDrawerTable();
    }

    function setWaterfallMode(mode) {
      waterfallChartMode = mode;
      renderFullDrawer();
    }

    function setWaterfallGranularity(granularity) {
      waterfallGranularity = granularity;
      renderFullDrawer();
    }

    function onDrawerFilterInput(val) {
      drawerFilterText = (val || '').toLowerCase().trim();
      renderDrawerTable();
    }

    function toggleTurnAccordion(turnNum, e) {
      if (e) e.stopPropagation();
      if (expandedTurnIds.has(turnNum)) {
        expandedTurnIds.delete(turnNum);
      } else {
        expandedTurnIds.add(turnNum);
      }
      renderDrawerTable();
    }

    function highlightAndScrollToTurn(elemId) {
      const row = document.getElementById(elemId);
      if (!row) return;
      document.querySelectorAll('.turn-row').forEach(r => r.classList.remove('highlighted'));
      row.classList.add('highlighted');
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function renderDrawerChart() {
      const data = activeDrawerData;
      if (!data) return;

      const turns = data.turns || [];
      const allSteps = data.allSteps || [];
      const effectiveGranularity = waterfallGranularity === 'auto' 
        ? (turns.length > 1 ? 'turns' : 'steps') 
        : waterfallGranularity;

      const items = effectiveGranularity === 'turns' ? turns : allSteps;
      if (!items || !items.length) return;

      const ctx = document.getElementById('drawerTurnsChart');
      if (!ctx) return;
      if (drawerChartInstance) drawerChartInstance.destroy();

      const labels = items.map(item => item.turn ? 'Turn #' + item.turn : 'Step #' + item.step);
      const peakCost = data.summary?.peakTurnCost || 0;

      let chartConfig;

      if (waterfallChartMode === 'waterfall') {
        // Floating Staircase Waterfall [startCost, endCost]
        chartConfig = {
          type: 'bar',
          data: {
            labels,
            datasets: [{
              label: 'Cumulative Cost Step ($)',
              data: items.map(it => [it.startCost, it.endCost]),
              backgroundColor: items.map(it => it.cost >= peakCost && peakCost > 0 ? '#d29922' : 'rgba(88, 166, 255, 0.85)'),
              borderColor: items.map(it => it.cost >= peakCost && peakCost > 0 ? '#f0883e' : '#58a6ff'),
              borderWidth: 1,
              borderRadius: 3
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: '#161b22',
                titleColor: '#f0f6fc',
                bodyColor: '#c9d1d9',
                borderColor: '#30363d',
                borderWidth: 1,
                padding: 10,
                callbacks: {
                  title: (context) => {
                    const it = items[context[0].dataIndex];
                    return (it.turn ? 'Turn #' + it.turn : 'Step #' + it.step) + (it.promptSnippet ? ': ' + it.promptSnippet.slice(0, 36) + '...' : '');
                  },
                  label: (context) => {
                    const it = items[context.dataIndex];
                    return [
                      'Turn Spend: +' + '$' + it.cost.toFixed(4) + ' (' + (it.percentOfTotal || 0) + '% of session)',
                      'Cumulative Spend: $' + it.startCost.toFixed(4) + ' → $' + it.endCost.toFixed(4),
                      it.stepsCount !== undefined ? 'Model Steps: ' + it.stepsCount : 'Finish: ' + (it.finish || 'step'),
                      'Input: ' + formatNumber(it.tokensInput) + ' fresh | ' + formatNumber(it.tokensCacheRead) + ' cached (' + it.cacheRatio + '%)',
                      'Output: ' + formatNumber(it.tokensOutput) + ' tokens'
                    ];
                  }
                }
              }
            },
            scales: {
              x: { ticks: { color: '#8b949e', font: { size: 9 }, maxRotation: 45 }, grid: { display: false } },
              y: { 
                ticks: { color: '#58a6ff', font: { size: 10 }, callback: v => '$' + v.toFixed(3) }, 
                grid: { color: '#21262d' } 
              }
            },
            onClick: (e, elements) => {
              if (elements && elements.length > 0) {
                const it = items[elements[0].index];
                highlightAndScrollToTurn(it.turn ? 'turn-row-' + it.turn : 'step-row-' + it.step);
              }
            }
          }
        };
      } else if (waterfallChartMode === 'spikes') {
        // Dual Axis: Turn Cost bar (left) + Cumulative Line (right)
        chartConfig = {
          type: 'bar',
          data: {
            labels,
            datasets: [
              {
                type: 'bar',
                label: 'Turn Cost ($)',
                data: items.map(it => it.cost),
                backgroundColor: items.map(it => it.cost >= peakCost && peakCost > 0 ? '#d29922' : 'rgba(88, 166, 255, 0.85)'),
                borderRadius: 3,
                yAxisID: 'yCost',
                order: 2
              },
              {
                type: 'line',
                label: 'Cumulative Total ($)',
                data: items.map(it => it.endCost),
                borderColor: '#3fb950',
                backgroundColor: 'rgba(63, 185, 80, 0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 3,
                yAxisID: 'yCumulative',
                order: 1
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { position: 'top', labels: { color: '#8b949e', font: { size: 10 }, boxWidth: 10 } },
              tooltip: {
                backgroundColor: '#161b22',
                titleColor: '#f0f6fc',
                bodyColor: '#c9d1d9',
                borderColor: '#30363d',
                borderWidth: 1,
                callbacks: {
                  title: (context) => {
                    const it = items[context[0].dataIndex];
                    return (it.turn ? 'Turn #' + it.turn : 'Step #' + it.step) + (it.promptSnippet ? ': ' + it.promptSnippet.slice(0, 36) + '...' : '');
                  }
                }
              }
            },
            scales: {
              x: { ticks: { color: '#8b949e', font: { size: 9 } }, grid: { display: false } },
              yCost: { 
                type: 'linear', position: 'left', 
                ticks: { color: '#58a6ff', font: { size: 9 }, callback: v => '$' + v.toFixed(3) }, 
                grid: { color: '#21262d' } 
              },
              yCumulative: { 
                type: 'linear', position: 'right', 
                ticks: { color: '#3fb950', font: { size: 9 }, callback: v => '$' + v.toFixed(2) }, 
                grid: { display: false } 
              }
            },
            onClick: (e, elements) => {
              if (elements && elements.length > 0) {
                const it = items[elements[0].index];
                highlightAndScrollToTurn(it.turn ? 'turn-row-' + it.turn : 'step-row-' + it.step);
              }
            }
          }
        };
      } else {
        // Token Flow: Fresh Input + Cached Read + Output Stacked
        chartConfig = {
          type: 'bar',
          data: {
            labels,
            datasets: [
              {
                label: 'Fresh Input',
                data: items.map(it => it.tokensInput),
                backgroundColor: '#58a6ff',
                stack: 'tokens'
              },
              {
                label: 'Cached Read',
                data: items.map(it => it.tokensCacheRead),
                backgroundColor: '#3fb950',
                stack: 'tokens'
              },
              {
                label: 'Output',
                data: items.map(it => it.tokensOutput),
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
              y: { ticks: { color: '#8b949e', font: { size: 9 }, callback: v => formatNumber(v) }, grid: { color: '#21262d' } }
            },
            onClick: (e, elements) => {
              if (elements && elements.length > 0) {
                const it = items[elements[0].index];
                highlightAndScrollToTurn(it.turn ? 'turn-row-' + it.turn : 'step-row-' + it.step);
              }
            }
          }
        };
      }

      drawerChartInstance = new Chart(ctx, chartConfig);
    }

    function renderDrawerTable() {
      const container = document.getElementById('drawerTurnsList');
      if (!container) return;

      const data = activeDrawerData;
      if (!data) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 16px;">No turns recorded.</div>';
        return;
      }

      const turns = data.turns || [];
      const allSteps = data.allSteps || [];
      const effectiveGranularity = waterfallGranularity === 'auto' 
        ? (turns.length > 1 ? 'turns' : 'steps') 
        : waterfallGranularity;

      const peakCost = data.summary?.peakTurnCost || 0;

      if (effectiveGranularity === 'turns') {
        const filteredTurns = turns.filter(t => {
          if (!drawerFilterText) return true;
          const matchPrompt = (t.fullPrompt || '').toLowerCase().includes(drawerFilterText);
          const matchTools = Object.keys(t.tools || {}).some(k => k.toLowerCase().includes(drawerFilterText));
          return matchPrompt || matchTools;
        });

        if (!filteredTurns.length) {
          container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 16px;">No turns match the filter.</div>';
          return;
        }

        container.innerHTML = \`
          <table class="turns-table">
            <thead>
              <tr>
                <th style="width: 32px;">#</th>
                <th>Prompt / User Action</th>
                <th>Steps</th>
                <th>Turn Cost</th>
                <th>Cumulative</th>
                <th>Fresh In</th>
                <th>Cache %</th>
                <th>Output</th>
                <th>Tools</th>
              </tr>
            </thead>
            <tbody>
              \${filteredTurns.map(t => {
                const isExpanded = expandedTurnIds.has(t.turn);
                const hasSteps = t.steps && t.steps.length > 0;
                const isPeak = t.cost >= peakCost && peakCost > 0;
                const toolsBadges = Object.entries(t.tools || {}).map(([name, count]) => \`
                  <span class="tool-chip" style="font-size: 10px; padding: 1px 5px; border-left: 2px solid \${getToolColor(name)};">
                    <b style="color: \${getToolColor(name)};">\${name}</b> \${count}
                  </span>
                \`).join('') || '-';

                const maxPct = Math.min(100, Math.max(5, (t.percentOfTotal || 0)));

                return \`
                  <tr class="turn-row" id="turn-row-\${t.turn}" onclick="toggleTurnAccordion(\${t.turn}, event)">
                    <td style="font-weight: 600; color: var(--accent-blue); white-space: nowrap;">
                      \${hasSteps ? \`<span class="accordion-toggle \${isExpanded ? 'expanded' : ''}">▶</span>\` : ''}
                      #\${t.turn}
                    </td>
                    <td class="turns-prompt" title="\${(t.fullPrompt || '').replace(/"/g, '&quot;')}">
                      \${t.promptSnippet}
                    </td>
                    <td>
                      <span class="badge badge-purple">\${t.stepsCount}</span>
                    </td>
                    <td style="font-family: monospace; font-weight: 600; \${isPeak ? 'color: var(--accent-amber);' : ''}">
                      <div class="cost-bar-container">
                        <span>$\${t.cost.toFixed(4)}</span>
                        <div class="cost-progress" title="\${t.percentOfTotal}% of session spend">
                          <div class="cost-progress-fill \${isPeak ? 'peak' : ''}" style="width: \${maxPct}%;"></div>
                        </div>
                      </div>
                    </td>
                    <td style="font-family: monospace; color: var(--text-muted);">$\${t.cumulativeCost.toFixed(4)}</td>
                    <td style="font-family: monospace;">\${formatNumber(t.tokensInput)}</td>
                    <td><span class="badge badge-green">\${t.cacheRatio}%</span></td>
                    <td style="font-family: monospace;">\${formatNumber(t.tokensOutput)}</td>
                    <td>\${toolsBadges}</td>
                  </tr>
                  \${isExpanded && hasSteps ? \`
                    <tr style="background: rgba(0,0,0,0.25);">
                      <td colspan="9" style="padding: 0;">
                        <div class="steps-subtable-container">
                          <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 6px; font-weight: 600; text-transform: uppercase;">
                            Nested LLM Invocations in Turn #\${t.turn}
                          </div>
                          <table class="steps-subtable">
                            <thead>
                              <tr>
                                <th>Step</th>
                                <th>Tools Invoked</th>
                                <th>Cost</th>
                                <th>Fresh In</th>
                                <th>Cache Read</th>
                                <th>Out</th>
                                <th>Finish</th>
                              </tr>
                            </thead>
                            <tbody>
                              \${t.steps.map(st => \`
                                <tr>
                                  <td style="color: var(--accent-purple); font-weight: 600;">Step \${st.step}</td>
                                  <td>
                                    \${st.tools.map(tool => \`<span class="tool-chip" style="font-size: 10px; padding: 1px 4px; border-left: 2px solid \${getToolColor(tool)};"><b style="color: \${getToolColor(tool)};">\${tool}</b></span>\`).join(' ') || '<span style="color: var(--text-muted);">-</span>'}
                                  </td>
                                  <td style="font-family: monospace; font-weight: 600;">$\${st.cost.toFixed(4)}</td>
                                  <td style="font-family: monospace;">\${formatNumber(st.tokensInput)}</td>
                                  <td style="font-family: monospace; color: var(--accent-green);">\${formatNumber(st.tokensCacheRead)} (\${st.cacheRatio}%)</td>
                                  <td style="font-family: monospace;">\${formatNumber(st.tokensOutput)}</td>
                                  <td style="color: var(--text-muted);">\${st.finish || '-'}</td>
                                </tr>
                              \`).join('')}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  \` : ''}
                \`;
              }).join('')}
            </tbody>
          </table>
        \`;
      } else {
        // Steps Granularity
        const filteredSteps = allSteps.filter(st => {
          if (!drawerFilterText) return true;
          const matchTool = (st.tools || []).some(t => t.toLowerCase().includes(drawerFilterText));
          const matchFinish = (st.finish || '').toLowerCase().includes(drawerFilterText);
          return matchTool || matchFinish;
        });

        if (!filteredSteps.length) {
          container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 16px;">No model steps match the filter.</div>';
          return;
        }

        container.innerHTML = \`
          <table class="turns-table">
            <thead>
              <tr>
                <th style="width: 48px;">Step #</th>
                <th>Tools Called</th>
                <th>Step Cost</th>
                <th>Cumulative</th>
                <th>Fresh In</th>
                <th>Cache Read</th>
                <th>Output</th>
                <th>Finish / Mode</th>
              </tr>
            </thead>
            <tbody>
              \${filteredSteps.map(st => {
                const isPeak = st.cost >= peakCost && peakCost > 0;
                const toolBadges = (st.tools || []).map(tool => \`
                  <span class="tool-chip" style="font-size: 10px; padding: 1px 5px; border-left: 2px solid \${getToolColor(tool)};">
                    <b style="color: \${getToolColor(tool)};">\${tool}</b>
                  </span>
                \`).join('') || '<span style="color: var(--text-muted);">-</span>';

                const maxPct = Math.min(100, Math.max(5, (st.percentOfTotal || 0)));

                return \`
                  <tr class="turn-row" id="step-row-\${st.step}">
                    <td style="font-weight: 600; color: var(--accent-purple);">#\${st.step}</td>
                    <td>\${toolBadges}</td>
                    <td style="font-family: monospace; font-weight: 600; \${isPeak ? 'color: var(--accent-amber);' : ''}">
                      <div class="cost-bar-container">
                        <span>$\${st.cost.toFixed(4)}</span>
                        <div class="cost-progress" title="\${st.percentOfTotal}% of session spend">
                          <div class="cost-progress-fill \${isPeak ? 'peak' : ''}" style="width: \${maxPct}%;"></div>
                        </div>
                      </div>
                    </td>
                    <td style="font-family: monospace; color: var(--text-muted);">$\${st.cumulativeCost.toFixed(4)}</td>
                    <td style="font-family: monospace;">\${formatNumber(st.tokensInput)}</td>
                    <td style="font-family: monospace; color: var(--accent-green);">\${formatNumber(st.tokensCacheRead)} (\${st.cacheRatio}%)</td>
                    <td style="font-family: monospace;">\${formatNumber(st.tokensOutput)}</td>
                    <td style="color: var(--text-muted); font-size: 11px;">\${st.finish || '-'}</td>
                  </tr>
                \`;
              }).join('')}
            </tbody>
          </table>
        \`;
      }
    }

    function updateDrawerTelemetry() {
      if (!activeDrawerData) return;
      renderDrawerChart();
      renderDrawerTable();
    }

    function closeDrawer() {
      activeDrawerSessionId = null;
      activeDrawerData = null;
      activeDrawerSession = null;
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

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 })
    }

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
console.log(`Telemetry sources (${findAllDbs().length}): ${findAllDbs().join(", ")}`)
console.log(`Auto-refreshing every 2.5s from SQLite journal.\n`)
