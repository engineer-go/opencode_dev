---
name: effect
description: Work with Effect v4 / effect-smol TypeScript services, schemas, and layers in this repo. Use when writing or migrating Effect code, service layers, or Effect-based tests.
---

# Effect

This codebase uses Effect for typed, composable TypeScript services, schemas, and workflows.

## Source Of Truth

Use the current Effect v4 / effect-smol source, not memory or older Effect v2/v3 examples.

1. Use the configured `effect` reference (wired in `.opencode/opencode.jsonc`): `~/.local/share/opencode/repos/github.com/Effect-TS/effect-smol`. Do not clone a second copy into the project.
2. Search that reference for exact APIs, examples, tests, and naming patterns before answering or implementing Effect-specific code.
3. Also inspect existing repo code for local house style before introducing new patterns.
4. Prefer answers and implementations backed by specific source files or nearby repo examples.

## Guidelines

- Prefer current Effect v4 APIs and project-local patterns over old blog posts, examples, or package-memory guesses.
- Use `Effect.gen(function* () { ... })` for multi-step workflows.
- Use `Effect.fn("Name")` or `Effect.fnUntraced(...)` for named effects when adding reusable service methods or important workflows.
- Prefer Effect `Schema` for API and domain data shapes. Use branded schemas for IDs and `Schema.TaggedErrorClass` for typed domain errors when modeling new error surfaces.
- Keep HTTP handlers thin: decode input, read request context, call services, and map transport errors. Put business rules in services.
- In Effect service code, prefer Effect-aware platform abstractions and dependencies over ad hoc promises where the surrounding code already does so.
- Keep layer composition explicit. Avoid broad hidden provisioning that makes missing dependencies hard to see.
- Do not introduce `any`, non-null assertions, unchecked casts, or older Effect APIs just to satisfy types.
- Do not answer from memory. Verify against the `effect` reference or nearby code first.

## Testing Patterns

- Use `testEffect(...)` from `packages/opencode/test/lib/effect.ts` for Effect services, layers, and scoped resources; `it.live(...)` for filesystem, git, servers, sockets, child processes, locks, and real time.
- Test placement, mocks, and typechecking follow root `AGENTS.md` Testing / Type Checking and `packages/opencode/AGENTS.md`; this skill does not restate them.
