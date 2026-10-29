type Start = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
}

let listener: { stop(close?: boolean): void | Promise<void> } | undefined

async function stop() {
  await listener?.stop(true)
  process.send?.({ type: "stopped" })
  process.exit(process.exitCode ?? 0)
}

async function start(command: Start) {
  process.env.OPENCODE_SERVER_USERNAME = "opencode"
  process.env.OPENCODE_SERVER_PASSWORD = command.password
  process.env.XDG_STATE_HOME ??= command.userDataPath
  for (const key of ["NO_PROXY", "no_proxy"]) {
    process.env[key] = [...new Set([...(process.env[key]?.split(",") ?? []), "127.0.0.1", "localhost", "::1"])].join(
      ",",
    )
  }
  const { Server } = await import("./server/server")
  listener = await Server.listen({
    hostname: command.hostname,
    port: command.port,
    cors: ["oc://renderer"],
  })
  process.send?.({ type: "ready" })
}

process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || !("type" in message)) return
  if (message.type === "stop") return void stop()
  if (
    message.type !== "start" ||
    !("hostname" in message) ||
    typeof message.hostname !== "string" ||
    !("port" in message) ||
    typeof message.port !== "number" ||
    !("password" in message) ||
    typeof message.password !== "string" ||
    !("userDataPath" in message) ||
    typeof message.userDataPath !== "string"
  )
    return
  void start({
    type: "start",
    hostname: message.hostname,
    port: message.port,
    password: message.password,
    userDataPath: message.userDataPath,
  }).catch((error: unknown) => {
    process.send?.({
      type: "error",
      error: { message: error instanceof Error ? error.message : String(error) },
    })
    process.exitCode = 1
    process.disconnect?.()
  })
})
process.on("disconnect", () => void stop())
process.on("SIGTERM", () => void stop())
