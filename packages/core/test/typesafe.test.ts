import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Config } from "@opencode-ai/core/config"
import { TypeSafeClient } from "@opencode-ai/core/typesafe/client"
import { SkillSuggestion } from "@opencode-ai/core/typesafe/skill-suggestion"
import { Integration } from "@opencode-ai/core/integration"
import { Credential } from "@opencode-ai/core/credential"
import {
  ChoiceAnswer,
  NoulAnswer,
  SystemOneRequest,
  SystemOneResponse,
} from "@opencode-ai/core/typesafe/types"
import type { SkillV2 } from "@opencode-ai/core/skill"

const mockSkill = (name: string, description: string, content: string): SkillV2.Info => ({
  name,
  description,
  content,
  location: AbsolutePath.make(`/test/skills/${name}/SKILL.md`),
})

describe("SkillSuggestion.suggestionBlock", () => {
  test("formats with winner skill name", () => {
    const block = SkillSuggestion.suggestionBlock("pptx-author")
    expect(block).toContain("<skill_relevance>")
    expect(block).toContain("Relevant to the current request: pptx-author.")
    expect(block).toContain("</skill_relevance>")
  })

  test("formats when no skill matches", () => {
    const block = SkillSuggestion.suggestionBlock(undefined)
    expect(block).toContain("<skill_relevance>")
    expect(block).toContain("No skill in the roster appears relevant to this request.")
    expect(block).toContain("</skill_relevance>")
  })
})

describe("TypeSafeClient", () => {
  const originalEnv = process.env.TYPESAFE_API_KEY

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TYPESAFE_API_KEY
    } else {
      process.env.TYPESAFE_API_KEY = originalEnv
    }
  })

  const mockIntegration = (key?: string) =>
    Layer.succeed(
      Integration.Service,
      Integration.Service.of({
        connection: {
          active: () =>
            Effect.succeed(
              key
                ? {
                    type: "credential" as const,
                    id: Credential.ID.make("c_1"),
                    label: "default",
                  }
                : undefined,
            ),
          resolve: () =>
            Effect.succeed(key ? Credential.Key.make({ type: "key", key }) : undefined),
        } as unknown as Integration.Interface["connection"],
      } as unknown as Integration.Interface),
    )

  test("reports isConfigured = false when no key is set", async () => {
    delete process.env.TYPESAFE_API_KEY
    const configLayer = Layer.succeed(
      Config.Service,
      Config.Service.of({
        entries: () => Effect.succeed([]),
      }),
    )

    const program = Effect.gen(function* () {
      const client = yield* TypeSafeClient.Service
      return yield* client.isConfigured()
    }).pipe(
      Effect.provide(TypeSafeClient.locationLayer),
      Effect.provide(configLayer),
      Effect.provide(mockIntegration()),
    )

    const isConfigured = await Effect.runPromise(program)
    expect(isConfigured).toBe(false)
  })

  test("reports isConfigured = true when TYPESAFE_API_KEY env is set", async () => {
    process.env.TYPESAFE_API_KEY = "test-key-123"
    const configLayer = Layer.succeed(
      Config.Service,
      Config.Service.of({
        entries: () => Effect.succeed([]),
      }),
    )

    const program = Effect.gen(function* () {
      const client = yield* TypeSafeClient.Service
      return yield* client.isConfigured()
    }).pipe(
      Effect.provide(TypeSafeClient.locationLayer),
      Effect.provide(configLayer),
      Effect.provide(mockIntegration()),
    )

    const isConfigured = await Effect.runPromise(program)
    expect(isConfigured).toBe(true)
  })

  test("reports isConfigured = true when saved in Integration (e.g. via Settings -> Providers)", async () => {
    delete process.env.TYPESAFE_API_KEY
    const configLayer = Layer.succeed(
      Config.Service,
      Config.Service.of({
        entries: () => Effect.succeed([]),
      }),
    )

    const program = Effect.gen(function* () {
      const client = yield* TypeSafeClient.Service
      return yield* client.isConfigured()
    }).pipe(
      Effect.provide(TypeSafeClient.locationLayer),
      Effect.provide(configLayer),
      Effect.provide(mockIntegration("ts_saved_key_from_settings")),
    )

    const isConfigured = await Effect.runPromise(program)
    expect(isConfigured).toBe(true)
  })

  test("systemOne serializes and decodes SystemOneResponse", () => {
    // Verify SystemOneResponse schema decoding from raw API JSON
    const rawResponse = {
      model: "jev-latest",
      answers: {
        is_relevant: {
          type: "noul",
          noul: 0.95,
        },
      },
      usage: {
        input_tokens: 42,
        output_tokens: 10,
      },
    }

    const decoded = Schema.decodeUnknownSync(SystemOneResponse)(rawResponse)
    expect(decoded.model).toBe("jev-latest")
    const ans = decoded.answers.is_relevant
    expect(ans instanceof NoulAnswer).toBe(true)
    if (ans instanceof NoulAnswer) {
      expect(ans.noul).toBe(0.95)
    }
  })
})

describe("SkillSuggestion.Service", () => {
  const skills = [
    mockSkill(
      "git-commit",
      "Drafts clean git commits",
      "# git-commit\nInstructions for writing git commits.",
    ),
    mockSkill(
      "code-review",
      "Reviews pull requests for standards",
      "# code-review\nReview code against repo guidelines.",
    ),
  ]

  test("returns undefined when TypeSafe is not configured", async () => {
    const clientLayer = Layer.succeed(
      TypeSafeClient.Service,
      TypeSafeClient.Service.of({
        isConfigured: () => Effect.succeed(false),
        systemOne: () =>
          Effect.fail(new TypeSafeClient.TypeSafeError({ message: "Not configured" })),
      }),
    )

    const program = Effect.gen(function* () {
      const suggestion = yield* SkillSuggestion.Service
      return yield* suggestion.suggest({
        request: "Please review this pull request",
        skills,
      })
    }).pipe(Effect.provide(SkillSuggestion.locationLayer), Effect.provide(clientLayer))

    const result = await Effect.runPromise(program)
    expect(result).toBeUndefined()
  })

  test("returns suggested skill when gate and fit thresholds are satisfied", async () => {
    const mockClient = Layer.succeed(
      TypeSafeClient.Service,
      TypeSafeClient.Service.of({
        isConfigured: () => Effect.succeed(true),
        systemOne: (req: SystemOneRequest) => {
          // Pass 1 returns which choice and high gate nouls
          if ("gate::acts_on_user_system" in req.questions) {
            return Effect.succeed(
              new SystemOneResponse({
                model: "jev-latest",
                answers: {
                  which: new ChoiceAnswer({
                    type: "choice",
                    choice: "code-review",
                    probabilities: { "code-review": 0.85, "git-commit": 0.15 },
                    confidence: 0.85,
                  }),
                  "gate::acts_on_user_system": new NoulAnswer({ type: "noul", noul: 0.8 }),
                  "gate::would_follow_documented_procedure": new NoulAnswer({
                    type: "noul",
                    noul: 0.9,
                  }),
                  "gate::prose_suffices": new NoulAnswer({ type: "noul", noul: 0.1 }),
                },
              }),
            )
          }
          // Pass 2 returns reranked choice and fits noul
          return Effect.succeed(
            new SystemOneResponse({
              model: "jev-latest",
              answers: {
                which: new ChoiceAnswer({
                  type: "choice",
                  choice: "code-review",
                  probabilities: { "code-review": 0.92 },
                  confidence: 0.92,
                }),
                "fits::code-review": new NoulAnswer({ type: "noul", noul: 0.88 }),
                "fits::git-commit": new NoulAnswer({ type: "noul", noul: 0.05 }),
              },
            }),
          )
        },
      }),
    )

    const program = Effect.gen(function* () {
      const suggestion = yield* SkillSuggestion.Service
      return yield* suggestion.suggest({
        request: "Review this pull request against project standards",
        skills,
      })
    }).pipe(Effect.provide(SkillSuggestion.locationLayer), Effect.provide(mockClient))

    const result = await Effect.runPromise(program)
    expect(result).toBe("code-review")
  })

  test("returns undefined when gate rejects turn (e.g. casual prose request)", async () => {
    const mockClient = Layer.succeed(
      TypeSafeClient.Service,
      TypeSafeClient.Service.of({
        isConfigured: () => Effect.succeed(true),
        systemOne: () =>
          Effect.succeed(
            new SystemOneResponse({
              model: "jev-latest",
              answers: {
                which: new ChoiceAnswer({
                  type: "choice",
                  choice: "code-review",
                  probabilities: { "code-review": 0.5, "git-commit": 0.5 },
                  confidence: 0.5,
                }),
                "gate::acts_on_user_system": new NoulAnswer({ type: "noul", noul: 0.05 }),
                "gate::would_follow_documented_procedure": new NoulAnswer({
                  type: "noul",
                  noul: 0.05,
                }),
                "gate::prose_suffices": new NoulAnswer({ type: "noul", noul: 0.95 }),
              },
            }),
          ),
      }),
    )

    const program = Effect.gen(function* () {
      const suggestion = yield* SkillSuggestion.Service
      return yield* suggestion.suggest({
        request: "What is a monad in computer science?",
        skills,
      })
    }).pipe(Effect.provide(SkillSuggestion.locationLayer), Effect.provide(mockClient))

    const result = await Effect.runPromise(program)
    expect(result).toBeUndefined()
  })

  test("handles TypeSafe API failures gracefully without throwing", async () => {
    const mockClient = Layer.succeed(
      TypeSafeClient.Service,
      TypeSafeClient.Service.of({
        isConfigured: () => Effect.succeed(true),
        systemOne: () =>
          Effect.fail(new TypeSafeClient.TypeSafeError({ message: "Network connection timeout" })),
      }),
    )

    const program = Effect.gen(function* () {
      const suggestion = yield* SkillSuggestion.Service
      return yield* suggestion.suggest({
        request: "Review this pull request",
        skills,
      })
    }).pipe(Effect.provide(SkillSuggestion.locationLayer), Effect.provide(mockClient))

    const result = await Effect.runPromise(program)
    expect(result).toBeUndefined()
  })
})
