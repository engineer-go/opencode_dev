import { createSignal, onCleanup } from "solid-js"
import type { Prompt, ContentPart } from "@/context/prompt"
import { transcribeAudio, type TranscriptionConfig } from "./transcription"

export type DictationState = "idle" | "starting" | "recording" | "transcribing" | "error"

export interface DictationControllerOptions {
  getConfig: () => TranscriptionConfig
  onTranscript: (text: string) => void
  onError?: (error: Error) => void
}

export function appendDictationTranscript(prompt: Prompt, transcript: string): Prompt {
  const normalized = transcript.trim()
  if (!normalized) return prompt

  if (prompt.length === 0) {
    return [{ type: "text", content: normalized, start: 0, end: normalized.length }]
  }

  const lastIndex = prompt.length - 1
  const lastPart = prompt[lastIndex]

  if (lastPart.type === "text") {
    const separator = lastPart.content.length === 0 || /\s$/.test(lastPart.content) ? "" : " "
    const newContent = lastPart.content + separator + normalized
    const updated: ContentPart = {
      ...lastPart,
      content: newContent,
      end: lastPart.start + newContent.length,
    }
    return [...prompt.slice(0, lastIndex), updated]
  }

  const start = "end" in lastPart ? lastPart.end : 0
  const separator = " "
  const content = separator + normalized
  const newPart: ContentPart = {
    type: "text",
    content,
    start,
    end: start + content.length,
  }
  return [...prompt, newPart]
}

export function createDictationController(options: DictationControllerOptions) {
  const [state, setState] = createSignal<DictationState>("idle")
  const [error, setError] = createSignal<string | null>(null)

  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let chunks: BlobPart[] = []
  let abortController: AbortController | null = null

  const cleanupMedia = () => {
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop()
      } catch {}
    }
    recorder = null
    if (stream) {
      stream.getTracks().forEach((track) => {
        try {
          track.stop()
        } catch {}
      })
      stream = null
    }
    chunks = []
  }

  const cancel = () => {
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    cleanupMedia()
    setState("idle")
  }

  const start = async () => {
    if (state() === "recording" || state() === "transcribing" || state() === "starting") return
    cancel()
    setError(null)
    setState("starting")

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone input is not supported in this environment.")
      }

      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream = mediaStream

      const mimeType =
        typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm")
            ? "audio/webm"
            : typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/mp4")
              ? "audio/mp4"
              : ""

      const mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined)
      recorder = mediaRecorder
      chunks = []

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data)
        }
      }

      mediaRecorder.start(250)
      setState("recording")
    } catch (err: any) {
      cleanupMedia()
      const msg = err?.message || "Failed to start microphone recording"
      setError(msg)
      setState("error")
      options.onError?.(err instanceof Error ? err : new Error(msg))
    }
  }

  const stop = async () => {
    if (state() !== "recording") return
    const activeRecorder = recorder
    const activeStream = stream
    if (!activeRecorder) {
      cancel()
      return
    }

    setState("transcribing")
    abortController = new AbortController()

    try {
      const audioBlob = await new Promise<Blob>((resolve, reject) => {
        activeRecorder.onstop = () => {
          const type = activeRecorder.mimeType || "audio/webm"
          const blob = new Blob(chunks, { type })
          resolve(blob)
        }
        activeRecorder.onerror = (event: any) => {
          reject(new Error(event?.error?.message || "Audio recording error"))
        }
        activeRecorder.stop()
      })

      if (activeStream) {
        activeStream.getTracks().forEach((track) => {
          try {
            track.stop()
          } catch {}
        })
      }
      recorder = null
      stream = null

      const config = options.getConfig()
      const text = await transcribeAudio(audioBlob, config, abortController.signal)
      if (text) {
        options.onTranscript(text)
      }
      setState("idle")
    } catch (err: any) {
      cleanupMedia()
      if (abortController?.signal.aborted) {
        setState("idle")
        return
      }
      const msg = err?.message || "Transcription failed"
      setError(msg)
      setState("error")
      options.onError?.(err instanceof Error ? err : new Error(msg))
    } finally {
      abortController = null
    }
  }

  const toggle = () => {
    if (state() === "recording") {
      void stop()
    } else if (state() === "idle" || state() === "error") {
      void start()
    }
  }

  onCleanup(cancel)

  return {
    state,
    error,
    start,
    stop,
    cancel,
    toggle,
    isRecording: () => state() === "recording",
    isTranscribing: () => state() === "transcribing",
    isActive: () => state() === "recording" || state() === "transcribing" || state() === "starting",
  }
}
