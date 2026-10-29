import { parseArgs } from "node:util"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Inspect the real CLI's wire request. Never serialize authorization or messages.
export function proxy(input: {
  live: boolean
  provider?: "opencode" | "opencode-go"
  upstream?: string
  model: string
  report: (value: Record<string, unknown>) => void
}) {
  const provider = input.provider ?? "opencode-go"
  const upstream =
    input.upstream ??
    (provider === "opencode" ? "https://opencode.ai/inference/openai/v1" : "https://opencode.ai/zen/go/v1")
  let requests = 0
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++
      if (requests > 1) {
        input.report({ event: "retry-blocked", requests })
        return Response.json({ error: { message: "Probe permits one upstream request only" } }, { status: 400 })
      }
      const url = new URL(request.url)
      const body: unknown = await request.json()
      const model = body && typeof body === "object" && "model" in body ? body.model : undefined
      const valid = request.method === "POST" && url.pathname === "/v1/chat/completions" && model === input.model
      input.report({
        event: "request",
        valid,
        provider,
        endpoint: `${upstream}/chat/completions`,
        model,
        userAgent: request.headers.get("user-agent"),
        client: request.headers.get("x-opencode-client"),
        sessionHeader: request.headers.has("x-opencode-session"),
        requestHeader: request.headers.has("x-opencode-request"),
        authorizationPresent: Boolean(request.headers.get("authorization")),
      })
      if (!valid) return Response.json({ error: { message: "Unexpected request route or model" } }, { status: 400 })
      if (!input.live) {
        input.report({ event: "response", status: 200, mode: "offline" })
        return new Response(
          'data: {"id":"probe","object":"chat.completion.chunk","created":0,"model":"' +
            input.model +
            '","choices":[{"index":0,"delta":{"role":"assistant","content":"GO_PROBE_OK"},"finish_reason":null}]}\n\n' +
            'data: {"id":"probe","object":"chat.completion.chunk","created":0,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.delete("content-length")
      const response = await fetch(`${upstream}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      })
      input.report({
        event: "response",
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        requestID: response.headers.get("x-request-id"),
      })
      if (!response.ok) {
        const text = await response.text()
        input.report({
          event: "rejection",
          clientVersionRejected: text.includes("no longer supports free models"),
          freeUsageLimited: text.includes("FreeUsageLimitError"),
          reason: text.includes("no longer supports free models")
            ? "client-version-rejected"
            : text.includes("FreeUsageLimitError")
              ? "free-usage-limit"
              : text.includes("GoUsageLimitError")
                ? "go-quota-limit"
                : response.status === 401 || response.status === 403
                  ? "authentication-or-entitlement"
                  : "unclassified-see-provider-account",
        })
        // Report the upstream status, then return a terminal local error.
        // The probe must finish, even when the real client would sleep for hours.
        return Response.json(
          { error: { message: `Provider probe: upstream HTTP ${response.status}` } },
          { status: 400 },
        )
      }
      return new Response(response.body, { status: response.status, headers: response.headers })
    },
  })
}

if (import.meta.main) {
  const args = parseArgs({
    options: {
      live: { type: "boolean", default: false },
      provider: { type: "string", default: "opencode-go" },
      model: { type: "string" },
      cli: { type: "string" },
      timeout: { type: "string", default: "60" },
      upstream: { type: "string" },
    },
  }).values
  if (args.provider !== "opencode" && args.provider !== "opencode-go")
    throw new Error("Provider must be opencode or opencode-go")
  const provider = args.provider
  if (args.live && !args.model) throw new Error(`Live mode requires --model from \`opencode models ${provider}\``)
  const model = args.model ?? (provider === "opencode" ? "ring-2.6-1t-free" : "deepseek-v4-flash")
  if (!/^[\w.-]+$/.test(model)) throw new Error("Pass the model ID without a provider prefix")
  if (provider === "opencode" && !model.endsWith("-free"))
    throw new Error("The opencode probe requires a free model ID")
  const timeout = Number(args.timeout)
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300) throw new Error("Timeout must be 1–300 seconds")
  const report = (value: Record<string, unknown>) => console.log(JSON.stringify(value))
  const server = proxy({ live: args.live, provider, model, upstream: args.upstream, report })
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-go-probe-"))
  const command = args.cli
    ? [path.resolve(args.cli)]
    : [process.execPath, path.resolve(import.meta.dir, "../src/index.ts")]
  const config = {
    enabled_providers: [provider],
    small_model: `${provider}/${model}`,
    share: "disabled",
    permission: "deny",
    agent: {
      "go-probe": { mode: "primary", prompt: "Reply only GO_PROBE_OK. Do not call tools.", tools: { "*": false } },
    },
    provider: {
      [provider]: {
        options: { baseURL: `${server.url}v1`, ...(!args.live ? { apiKey: "offline-probe-key" } : {}) },
      },
    },
  }
  const child = Bun.spawn(
    [
      ...command,
      "run",
      "--dir",
      dir,
      "--title",
      "Go probe",
      "--model",
      `${provider}/${model}`,
      "--agent",
      "go-probe",
      "--format",
      "json",
      "Reply only GO_PROBE_OK",
    ],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        ...(!args.live
          ? { OPENCODE_MODELS_PATH: path.resolve(import.meta.dir, "../test/tool/fixtures/models-api.json") }
          : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, timeout * 1000)
  try {
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const generatedText = stdout
      .split("\n")
      .some((line) => line.includes('"type":"text"') && line.includes("GO_PROBE_OK"))
    report({ event: "result", provider, mode: args.live ? "live" : "offline", exitCode, timedOut, generatedText })
    process.exitCode = exitCode === 0 && generatedText && !timedOut ? 0 : 1
  } finally {
    clearTimeout(timer)
    child.kill()
    server.stop(true)
    await rm(dir, { recursive: true, force: true })
  }
}
