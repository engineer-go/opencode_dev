<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
</p>

---

### Installation

```bash
# YOLO

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

| Platform              | Download                         |
| --------------------- | -------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg` |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`   |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`   |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Building From Source

Requires [Bun](https://bun.sh) `1.3.x` or newer. On macOS, install the Xcode command line tools first (`xcode-select --install`).

```bash
# Install workspace dependencies (run from the repo root)
bun install

# Run the desktop app in development
bun run dev:desktop

# Build the app's JS assets, then bundle it into dist/
bun run --cwd packages/desktop build
bun run --cwd packages/desktop package:mac    # or package:linux on Linux
```

Artifacts land in `packages/desktop/dist/`:

- macOS: `mac-arm64/OpenCode Dev.app`, `opencode-desktop-mac-arm64.dmg`, `opencode-desktop-mac-arm64.zip`
- Linux: `opencode-desktop-linux-<arch>.deb`

Local builds default to the `dev` channel, so the app is named **OpenCode Dev** and the titlebar shows a `DEV <build>` stamp to tell builds apart. Set `OPENCODE_CHANNEL=dev|beta|prod` to change the channel and `OPENCODE_BUILD=<label>` to override the stamp.

Local builds are unsigned, so macOS Gatekeeper blocks the first launch. Open the app once from Finder with **Open**, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine "packages/desktop/dist/mac-arm64/OpenCode Dev.app"
```

#### Installation Directory

The installation script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).
