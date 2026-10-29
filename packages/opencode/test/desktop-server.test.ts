import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import path from "node:path"
import { tmpdir } from "./fixture/fixture"

test("desktop backend handles IPC startup, authentication, and shutdown", async () => {
  await using tmp = await tmpdir()
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  reservation.stop(true)
  const password = crypto.randomUUID()
  const child = spawn(process.execPath, [path.resolve(import.meta.dir, "../src/desktop-server.ts")], {
    env: { ...process.env, OPENCODE_DB: path.join(tmp.path, "server.db") },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  try {
    const ready = once(child, "message", { signal: AbortSignal.timeout(15000) })
    child.send({ type: "start", hostname: "127.0.0.1", port, password, userDataPath: tmp.path })
    expect((await ready)[0]).toEqual({ type: "ready" })
    expect((await fetch(`http://127.0.0.1:${port}/config`)).status).toBe(401)
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/global/health`, {
          headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        })
      ).status,
    ).toBe(200)
    const stopped = once(child, "exit", { signal: AbortSignal.timeout(5000) })
    child.send({ type: "stop" })
    expect((await stopped)[0]).toBe(0)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}, 20000)
