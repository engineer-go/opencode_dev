import { describe, expect, test } from "bun:test"
import { isAbsolutePath, resolveRevealPath } from "./reveal-path"

describe("isAbsolutePath", () => {
  test("detects unix absolute paths", () => {
    expect(isAbsolutePath("/repo/a.ts")).toBe(true)
    expect(isAbsolutePath("repo/a.ts")).toBe(false)
    expect(isAbsolutePath("~/a.ts")).toBe(false)
  })
})

describe("resolveRevealPath", () => {
  test("keeps absolute paths untouched", () => {
    expect(resolveRevealPath("/tmp/out.dmg", "/repo", "/home/me")).toBe("/tmp/out.dmg")
  })

  test("joins relative paths against the directory", () => {
    expect(resolveRevealPath("packages/desktop/dist/app.dmg", "/repo", "/home/me")).toBe(
      "/repo/packages/desktop/dist/app.dmg",
    )
  })

  test("trims a trailing slash on the directory", () => {
    expect(resolveRevealPath("src/a.ts", "/repo/", "/home/me")).toBe("/repo/src/a.ts")
  })

  test("expands home", () => {
    expect(resolveRevealPath("~/.config/opencode", "/repo", "/home/me")).toBe("/home/me/.config/opencode")
    expect(resolveRevealPath("~", "/repo", "/home/me")).toBe("/home/me")
  })

  test("leaves home paths untouched without a home directory", () => {
    expect(resolveRevealPath("~/x", "/repo", "")).toBe("~/x")
  })

  test("ignores blank input", () => {
    expect(resolveRevealPath("   ", "/repo", "/home/me")).toBe("")
  })
})
