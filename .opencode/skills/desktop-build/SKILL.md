---
name: desktop-build
description: Build and package OpenCode Desktop and verify the bundle matches source. Use when rebuilding or packaging the desktop app, when a desktop change does not appear after rebuild and restart, or when running package:mac or package:linux.
---

# Desktop Build

`packages/desktop` builds with electron-vite:
- `packages/desktop/out/` holds build output for main, preload, and renderer.
- `packages/desktop/dist/` holds electron-builder artifacts (`.dmg`, `.zip`, `.deb`).

## Procedure

1. After changing renderer source (`packages/app`, `packages/session-ui`, `packages/ui`, or `packages/desktop/src/renderer`), rebuild before running or packaging:
   - From `packages/desktop`: `bun run build` (runs `prebuild`, which builds the node CLI, then `electron-vite build`).
   - Or `bunx electron-vite build` to rebuild without the CLI prebuild when `packages/opencode/dist/node` is already current.
2. Verify the bundle contains the new code before trusting a rebuild:
   - Confirm `out/renderer/assets/main-*.js` is newer than the source edit.
   - `rg -o "<new symbol or string>" packages/desktop/out/renderer/assets/main-*.js`
3. Package from the fresh output: `bun run package:mac` or `bun run package:linux`.
4. For live iteration, run `bun run dev` (electron-vite dev) instead of rebuilding and repackaging.

## Pitfalls

- `package:mac` and `package:linux` only repackage the existing `out/`; they do not rebuild the renderer or main process. Packaging without a prior build ships stale code.
- When a change works in dev but not after packaging, first confirm `out/renderer/assets/main-*.js` matches the source before debugging the feature itself.
