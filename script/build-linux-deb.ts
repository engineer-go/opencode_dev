#!/usr/bin/env bun
/**
 * Build the Linux desktop .deb from a clean checkout.
 *
 * Usage (from repo root):
 *   ./script/build-linux-deb.ts
 *   OPENCODE_CHANNEL=prod OPENCODE_BUILD=local ./script/build-linux-deb.ts
 */
import { $ } from "bun"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
process.chdir(root)

if (process.platform !== "linux") {
  console.error("This script only packages .deb on Linux. Current platform:", process.platform)
  process.exit(1)
}

const channel = process.env.OPENCODE_CHANNEL ?? "dev"
if (channel !== "dev" && channel !== "beta" && channel !== "prod") {
  console.error(`Invalid OPENCODE_CHANNEL=${channel} (expected dev|beta|prod)`)
  process.exit(1)
}

process.env.OPENCODE_CHANNEL = channel
process.env.OPENCODE_BUILD ??= "local"
// electron-builder still downloads fpm/toolsets over HTTPS; corp MITM breaks that even
// when Electron itself is provided via electronDist. Opt out with OPENCODE_INSECURE_TLS=0.
if (process.env.OPENCODE_INSECURE_TLS !== "0") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
  console.warn("NODE_TLS_REJECT_UNAUTHORIZED=0 (set OPENCODE_INSECURE_TLS=0 to disable)")
}

console.log(`Building OpenCode desktop .deb (channel=${channel}, build=${process.env.OPENCODE_BUILD})`)

// `bun run --cwd <pkg> <script>` — not `bun --cwd <pkg> run <script>` (Bun 1.4 treats the latter as help).
await $`bun run --cwd packages/app build`
await $`bun run --cwd packages/desktop build`
await $`bun run --cwd packages/desktop package:linux --publish never`

const dist = path.join(root, "packages/desktop/dist")
if (!existsSync(dist)) {
  console.error("packages/desktop/dist/ was not created — packaging likely did not run")
  process.exit(1)
}

const debs = [...new Bun.Glob("*.deb").scanSync({ cwd: dist })].map((name) => path.join(dist, name))
if (debs.length === 0) {
  console.error("No .deb produced in packages/desktop/dist/")
  process.exit(1)
}

console.log("Done. Install with:")
for (const deb of debs) {
  console.log(`  sudo apt-get install -y ./${path.relative(root, deb)}`)
}
