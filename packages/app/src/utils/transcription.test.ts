import { describe, expect, test, mock } from "bun:test"
import {
  audioFileExtension,
  resolveTranscriptionEndpoint,
  resolveTranscriptionModel,
  transcribeAudio,
  GROQ_AUDIO_URL,
  OPENAI_AUDIO_URL,
  GROQ_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
} from "./transcription"

describe("transcription utils", () => {
  test("resolves correct endpoint for providers", () => {
    expect(resolveTranscriptionEndpoint("groq")).toBe(GROQ_AUDIO_URL)
    expect(resolveTranscriptionEndpoint("openai")).toBe(OPENAI_AUDIO_URL)
  })

  test("resolves default and custom models", () => {
    expect(resolveTranscriptionModel("groq")).toBe(GROQ_DEFAULT_MODEL)
    expect(resolveTranscriptionModel("openai")).toBe(OPENAI_DEFAULT_MODEL)
    expect(resolveTranscriptionModel("groq", "custom-model")).toBe("custom-model")
  })

  test("maps mime types to appropriate file extensions", () => {
    expect(audioFileExtension("audio/webm")).toBe("webm")
    expect(audioFileExtension("audio/webm;codecs=opus")).toBe("webm")
    expect(audioFileExtension("audio/mp4")).toBe("m4a")
    expect(audioFileExtension("audio/wav")).toBe("wav")
    expect(audioFileExtension("audio/ogg")).toBe("ogg")
    expect(audioFileExtension("audio/mpeg")).toBe("mp3")
  })

  test("throws error if API key is missing", async () => {
    const blob = new Blob(["dummy audio"], { type: "audio/webm" })
    expect(
      transcribeAudio(blob, {
        provider: "groq",
        apiKey: "",
      }),
    ).rejects.toThrow("Missing API key")
  })

  test("successfully sends request and parses transcription response", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (_url, options) => {
      expect(options?.method).toBe("POST")
      return new Response(JSON.stringify({ text: "  hello from dictation  " }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch

    try {
      const blob = new Blob(["dummy audio content"], { type: "audio/webm" })
      const result = await transcribeAudio(blob, {
        provider: "groq",
        apiKey: "gsk_test_123",
      })
      expect(result).toBe("hello from dictation")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
