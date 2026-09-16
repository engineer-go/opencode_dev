import { describe, expect, test } from "bun:test"
import { inlineCodeKind } from "./markdown-inline-code-kind"

describe("inlineCodeKind", () => {
  test("leaves code expressions as normal inline code", () => {
    expect(
      inlineCodeKind(
        `case "question.asked": ... input.setStore("question", question.sessionID, [question]) / splice/insert`,
      ),
    ).toBeUndefined()
    expect(inlineCodeKind(`<SessionQuestionDock request={request} ... />`)).toBeUndefined()
    expect(inlineCodeKind(`from sync.data.question + sync.data.session.`)).toBeUndefined()
    expect(inlineCodeKind(`@opencode-ai/app <StatusPopover />)`)).toBeUndefined()
    expect(inlineCodeKind(`sync.data.session`)).toBeUndefined()
    expect(inlineCodeKind(`window.api`)).toBeUndefined()
    expect(inlineCodeKind(`1.2`)).toBeUndefined()
  })

  test("ignores bare words and partial names that are not paths", () => {
    expect(inlineCodeKind(`build`)).toBeUndefined()
    expect(inlineCodeKind(`.md`)).toBeUndefined()
    expect(inlineCodeKind(`.js`)).toBeUndefined()
    expect(inlineCodeKind(`profile`)).toBeUndefined()
    expect(inlineCodeKind(`hosts`)).toBeUndefined()
    expect(inlineCodeKind(`gradlew`)).toBeUndefined()
  })

  test("ignores emails and package scopes", () => {
    expect(inlineCodeKind(`bun@1.3.14`)).toBeUndefined()
    expect(inlineCodeKind(`user@example.com`)).toBeUndefined()
    expect(inlineCodeKind(`@opencode-ai/app`)).toBeUndefined()
    expect(inlineCodeKind(`@scope/pkg`)).toBeUndefined()
  })

  test("detects file and directory paths", () => {
    expect(inlineCodeKind(`app.tsx`)).toBe("path")
    expect(inlineCodeKind(`vite.config.mjs`)).toBe("path")
    expect(inlineCodeKind(`eslint.config.cjs`)).toBe("path")
    expect(inlineCodeKind(`app.d.ts`)).toBe("path")
    expect(inlineCodeKind(`component.svelte`)).toBe("path")
    expect(inlineCodeKind(`schema.graphql`)).toBe("path")
    expect(inlineCodeKind(`Dockerfile`)).toBe("path")
    expect(inlineCodeKind(`Dockerfile.dev`)).toBe("path")
    expect(inlineCodeKind(`dockerfile`)).toBe("path")
    expect(inlineCodeKind(`justfile`)).toBe("path")
    expect(inlineCodeKind(`.gitignore`)).toBe("path")
    expect(inlineCodeKind(`.env`)).toBe("path")
    expect(inlineCodeKind(`Cargo.lock`)).toBe("path")
    expect(inlineCodeKind(`go.sum`)).toBe("path")
    expect(inlineCodeKind(`bun.lockb`)).toBe("path")
    expect(inlineCodeKind(`terraform.tfvars`)).toBe("path")
    expect(inlineCodeKind(`pnpm-lock.yaml`)).toBe("path")
    expect(inlineCodeKind(`packages/desktop-electron`)).toBe("path")
    expect(inlineCodeKind(`~/.config/opencode`)).toBe("path")
    expect(inlineCodeKind(`session/status`)).toBe("path")
    expect(inlineCodeKind(`packages/desktop/dist/`)).toBe("path")
    expect(inlineCodeKind(`native/`)).toBe("path")
  })

  test("detects paths containing spaces", () => {
    expect(inlineCodeKind(`packages/desktop/dist/mac-arm64/OpenCode Dev.app`)).toBe("path")
    expect(inlineCodeKind(`/Applications/Visual Studio Code.app`)).toBe("path")
    expect(inlineCodeKind(`~/My Documents/notes.md`)).toBe("path")
    expect(inlineCodeKind(`some words here`)).toBeUndefined()
    expect(inlineCodeKind(`read the docs/guide`)).toBeUndefined()
  })

  test("detects urls", () => {
    expect(inlineCodeKind(`https://opencode.ai/docs`)).toBe("url")
    expect(inlineCodeKind(`http://localhost:4444`)).toBe("url")
    expect(inlineCodeKind(`file:///tmp/opencode`)).toBeUndefined()
    expect(inlineCodeKind(`ftp://opencode.ai/docs`)).toBeUndefined()
  })
})
