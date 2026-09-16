---
name: update-from-upstream
description: Sync this pruned OpenCode fork with upstream anomalyco/opencode. Use when asked to pull or merge a new upstream version, update the fork from dev, or resolve upstream merge conflicts.
---

# Update From Upstream

This repo is a personal fork of `anomalyco/opencode` (default branch `dev`) with cloud, web, stats, and sdk packages removed. Syncing means merging upstream `dev` into local `dev`.

## Fork constraints

- Unix-only (macOS/Linux). Do not add Windows or WSL handling.
- These packages stay removed: `console`, `web`, `stats`, `enterprise`, `function`, `slack`, `sdks/vscode`. Never resurrect one while merging.

## Procedure

1. Check the upstream remote, and add it if missing:
   - `git remote -v`
   - `git remote add upstream https://github.com/anomalyco/opencode.git`
2. Stash unrelated local edits; a merge needs a clean tracked tree. Leave untracked files alone.
   - `git stash push -m "wip (pre-upstream-merge)" -- <paths>`
3. Fetch, size the update, and preview conflicts before touching the tree:
   - `git fetch upstream dev`
   - `git rev-list --count HEAD..upstream/dev`
   - `git merge-base HEAD upstream/dev`
   - `git merge-tree --write-tree HEAD upstream/dev`
4. Merge:
   - `git merge upstream/dev --no-edit`
5. Resolve conflicts:
   - `modify/delete` conflicts are the norm. Upstream edits files inside the removed packages above; keep them deleted with `git rm` and never take upstream's side.
   - Content conflicts in retained files: take upstream's forward change (for example a version bump) while preserving fork-only additions. Read all three sides first: `git show <merge-base>:<file>`, `git show HEAD:<file>`, `git show upstream/dev:<file>`.
   - `bun.lock` is generated. Do not hand-merge it: clear the conflict by taking one side, then run `bun install` to regenerate it against the trimmed workspaces.
6. Verify before committing: `bun typecheck`, then run tests for the retained files the merge touched (for example `packages/opencode`, `packages/tui`).
7. Commit the merge, then restore stashed edits with `git stash pop`.

## Pitfalls

- Accepting upstream's side of a `modify/delete` conflict re-adds a package the fork removed and breaks the workspace set.
- A hand-merged `bun.lock` ends up inconsistent with the trimmed workspaces; always regenerate with `bun install`.
