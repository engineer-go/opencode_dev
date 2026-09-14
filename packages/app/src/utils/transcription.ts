export interface TranscriptionConfig {
  provider: "groq" | "openai"
  apiKey: string
  model?: string
  language?: string
  prompt?: string
}

export const GROQ_DEFAULT_MODEL = "whisper-large-v3-turbo"
export const OPENAI_DEFAULT_MODEL = "whisper-1"

export const GROQ_AUDIO_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
export const OPENAI_AUDIO_URL = "https://api.openai.com/v1/audio/transcriptions"

export function resolveTranscriptionEndpoint(provider: "groq" | "openai"): string {
  return provider === "groq" ? GROQ_AUDIO_URL : OPENAI_AUDIO_URL
}

export function resolveTranscriptionModel(provider: "groq" | "openai", configured?: string): string {
  if (configured && configured.trim()) return configured.trim()
  return provider === "groq" ? GROQ_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL
}

export function audioFileExtension(mimeType: string): string {
  if (mimeType.includes("mp4") || mimeType.includes("m4a") || mimeType.includes("aac")) return "m4a"
  if (mimeType.includes("wav")) return "wav"
  if (mimeType.includes("ogg")) return "ogg"
  if (mimeType.includes("mp3") || mimeType.includes("mpeg")) return "mp3"
  return "webm"
}

export async function transcribeAudio(
  audioBlob: Blob,
  config: TranscriptionConfig,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = config.apiKey.trim()
  if (!apiKey) {
    throw new Error(
      "Missing API key for audio transcription. Please configure your API key in Settings > General > Voice Dictation.",
    )
  }

  const endpoint = resolveTranscriptionEndpoint(config.provider)
  const model = resolveTranscriptionModel(config.provider, config.model)
  const ext = audioFileExtension(audioBlob.type)

  const formData = new FormData()
  formData.append("file", audioBlob, `recording.${ext}`)
  formData.append("model", model)
  formData.append("response_format", "json")

  if (config.language && config.language.trim()) {
    formData.append("language", config.language.trim())
  }
  if (config.prompt && config.prompt.trim()) {
    formData.append("prompt", config.prompt.trim())
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
    signal,
  })

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
    const message = errorBody?.error?.message ?? `Transcription failed with HTTP status ${response.status}`
    throw new Error(message)
  }

  const result = (await response.json()) as { text?: string }
  return (result.text ?? "").trim()
}
