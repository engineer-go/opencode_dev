import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { Configuration } from "electron-builder"

const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
} as const

const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
  version: string
  devDependencies?: { electron?: string }
}

/** Same stamp as packages/app/vite.js — override with OPENCODE_BUILD. */
const buildStamp = (() => {
  const raw = process.env.OPENCODE_BUILD
  if (raw) return raw
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
})()

/** Prefer a pre-downloaded Electron zip when TLS to GitHub fails (corp MITM / VPN). */
function resolveElectronDist() {
  if (process.env.ELECTRON_DIST) return process.env.ELECTRON_DIST
  const version = pkg.devDependencies?.electron
  if (!version || version.includes("/")) return undefined
  const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const zip = path.join(homedir(), ".cache", "electron", `electron-v${version}-${platform}-${arch}.zip`)
  if (existsSync(zip)) return zip
  return undefined
}

function linuxLauncherName() {
  if (channel === "prod") return "OpenCode"
  if (channel === "beta") return `OpenCode Beta ${buildStamp}`
  return `OpenCode Dev ${buildStamp}`
}

const electronDist = resolveElectronDist()

const getBase = (appId: string): Configuration => ({
  artifactName: "opencode-desktop-${os}-${arch}.${ext}",
  ...(electronDist ? { electronDist } : {}),
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*", "!out/**/*.map", "!out/**/*.d.ts", "resources/**/*", "!resources/opencode-cli*"],
  electronLanguages: ["en"],
  extraResources: [
    ...(channel === "dev"
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["opencode-cli*"],
          },
        ]
      : []),
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    identity: null,
    notarize: false,
    target: ["dmg", "zip"],
    extendInfo: {
      NSMicrophoneUsageDescription: "OpenCode needs microphone access for voice dictation.",
    },
  },
  dmg: {
    sign: false,
  },
  protocols: {
    name: "OpenCode",
    schemes: ["opencode"],
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
        // Keep productName stable for /opt paths; stamp only the menu label (like macOS titlebar DEV).
        Name: linuxLauncherName(),
        Comment: channel === "prod" ? "Open source AI coding agent" : `OpenCode ${channel} ${pkg.version} (${buildStamp})`,
      },
    },
    target: ["deb"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "OpenCode Dev",
        deb: { fpm: [metainfoFpm(appId)] },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "OpenCode Beta",
        protocols: { name: "OpenCode Beta", schemes: ["opencode"] },
        publish: { provider: "github", owner: "anomalyco", repo: "opencode-beta", channel: "latest" },
        deb: { fpm: [metainfoFpm(appId)] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "OpenCode",
        protocols: { name: "OpenCode", schemes: ["opencode"] },
        publish: { provider: "github", owner: "anomalyco", repo: "opencode", channel: "latest" },
        deb: { fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
