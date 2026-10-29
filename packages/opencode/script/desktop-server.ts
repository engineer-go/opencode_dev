import path from "node:path"
import { chmod } from "node:fs/promises"
import { Script } from "@opencode-ai/script"

process.chdir(path.resolve(import.meta.dir, ".."))
const { modelsData } = await import("./generate")
const output = path.resolve(
  "../desktop/resources",
  process.platform === "win32" ? "opencode-server.exe" : "opencode-server",
)
const result = await Bun.build({
  entrypoints: ["./src/desktop-server.ts"],
  minify: true,
  compile: {
    outfile: output,
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    execArgv: ["--use-system-ca"],
  },
  define: {
    OPENCODE_VERSION: JSON.stringify(Script.version),
    OPENCODE_CHANNEL: JSON.stringify(Script.channel),
    OPENCODE_MODELS_DEV: modelsData,
  },
  files: { "opencode-web-ui.gen.ts": "" },
})
if (!result.success) throw new AggregateError(result.logs, "Desktop server build failed")
if (process.platform !== "win32") await chmod(output, 0o755)
console.log(`Built desktop server: ${output}`)
