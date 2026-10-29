import { expect, test } from "bun:test"
import { proxy } from "../../script/go-probe"

test("Go probe validates the wire request, hides secrets, and blocks retries", async () => {
  const reports: Record<string, unknown>[] = []
  using server = proxy({ live: false, model: "deepseek-v4-flash", report: (value) => reports.push(value) })
  const response = await fetch(`${server.url}v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer private-test-key",
      "content-type": "application/json",
      "user-agent": "opencode/2.2.0",
      "x-opencode-client": "desktop",
      "x-opencode-session": "private-session-id",
      "x-opencode-request": "private-request-id",
    },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "private-prompt" }] }),
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("GO_PROBE_OK")
  expect(reports[0]).toMatchObject({ valid: true, userAgent: "opencode/2.2.0", authorizationPresent: true })
  expect(JSON.stringify(reports)).not.toContain("private-")
  expect((await fetch(server.url)).status).toBe(400)
  expect(reports.at(-1)?.event).toBe("retry-blocked")
})

test("Go probe rejects a mismatched model without forwarding it", async () => {
  const reports: Record<string, unknown>[] = []
  using server = proxy({ live: false, model: "deepseek-v4-flash", report: (value) => reports.push(value) })
  const response = await fetch(`${server.url}v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "free-model" }),
  })
  expect(response.status).toBe(400)
  expect(reports[0]?.valid).toBe(false)
})

test("free probe uses the current inference endpoint rather than the legacy Zen endpoint", async () => {
  const reports: Record<string, unknown>[] = []
  using server = proxy({
    live: false,
    provider: "opencode",
    model: "nemotron-3.5-lightning-free",
    report: (value) => reports.push(value),
  })
  const response = await fetch(`${server.url}v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "nemotron-3.5-lightning-free" }),
  })
  expect(response.status).toBe(200)
  expect(reports[0]).toMatchObject({
    valid: true,
    provider: "opencode",
    endpoint: "https://opencode.ai/inference/openai/v1/chat/completions",
    model: "nemotron-3.5-lightning-free",
  })
})
