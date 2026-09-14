import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { appendDictationTranscript } from "./dictation"

describe("dictation utils", () => {
  test("appends transcript to an empty prompt", () => {
    const prompt: Prompt = []
    const result = appendDictationTranscript(prompt, "hello world")
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: "text",
      content: "hello world",
      start: 0,
      end: 11,
    })
  })

  test("appends transcript with space to existing text prompt", () => {
    const prompt: Prompt = [{ type: "text", content: "fix the bug", start: 0, end: 11 }]
    const result = appendDictationTranscript(prompt, "in auth service")
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: "text",
      content: "fix the bug in auth service",
      start: 0,
      end: 27,
    })
  })

  test("does not add duplicate space if existing prompt already ends with space", () => {
    const prompt: Prompt = [{ type: "text", content: "fix the bug ", start: 0, end: 12 }]
    const result = appendDictationTranscript(prompt, "in auth service")
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: "text",
      content: "fix the bug in auth service",
      start: 0,
      end: 27,
    })
  })

  test("appends new text part when last part is a non-text item (e.g. file attachment)", () => {
    const prompt: Prompt = [
      {
        type: "file",
        path: "src/auth.ts",
        content: "@auth.ts",
        start: 0,
        end: 8,
      },
    ]
    const result = appendDictationTranscript(prompt, "review this code")
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "file", path: "src/auth.ts" })
    expect(result[1]).toMatchObject({
      type: "text",
      content: " review this code",
    })
  })

  test("returns unchanged prompt if transcript is empty or whitespace", () => {
    const prompt: Prompt = [{ type: "text", content: "hello", start: 0, end: 5 }]
    expect(appendDictationTranscript(prompt, "")).toEqual(prompt)
    expect(appendDictationTranscript(prompt, "   \n  ")).toEqual(prompt)
  })
})
