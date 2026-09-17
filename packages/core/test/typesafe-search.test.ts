import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { NonNegativeInt, PositiveInt, RelativePath } from "@opencode-ai/core/schema"
import { TypeSafeClient } from "@opencode-ai/core/typesafe/client"
import { SearchRerank } from "@opencode-ai/core/typesafe/search-rerank"
import { SemanticFind } from "@opencode-ai/core/typesafe/semantic-find"
import {
  ChoiceAnswer,
  NoulAnswer,
  SystemOneRequest,
  SystemOneResponse,
} from "@opencode-ai/core/typesafe/types"

const mockMatch = (file: string, line: number, text: string): FileSystem.Match =>
  FileSystem.Match.make({
    entry: FileSystem.Entry.make({
      path: RelativePath.make(file),
      type: "file",
    }),
    line: PositiveInt.make(line),
    offset: NonNegativeInt.make(0),
    text,
    submatches: [],
  })

describe("SearchRerank.Service", () => {
  test("returns empty array for empty matches", async () => {
    const clientLayer = Layer.succeed(
      TypeSafeClient.Service,
      TypeSafeClient.Service.of({
        isConfigured: () => Effect.succeed(true),
        systemOne: () => Effect.fail(new TypeSafeClient.TypeSafeError({ message: "Unused" })),
      }),
    )

    const program = Effect.gen(function* () {
      const rerank = yield* SearchRerank.Service
      return yield* rerank.rerank({ query: "auth token", matches: [] })
    }).pipe(Effect.provide(SearchRerank.locationLayer), Effect.provide(clientLayer))

    const result = await Effect.runPromise(program)
    expect(result).toHaveLength(0)
  })

  test("returns single match immediately with relevance 1.0", async () => {
    const clientLayer = Layer.succeed(
      TypeSafeClient.Service,
      TypeSafeClient.Service.of({
        isConfigured: () => Effect.succeed(true),
        systemOne: () => Effect.fail(new TypeSafeClient.TypeSafeError({ message: "Unused" })),
      }),
    )

    const m = mockMatch("src/auth.ts", 10, "export function authenticate() {}")
    const program = Effect.gen(function* () {
      const rerank = yield* SearchRerank.Service
      return yield* rerank.rerank({ query: "auth function", matches: [m] })
    }).pipe(Effect.provide(SearchRerank.locationLayer), Effect.provide(clientLayer))

    const result = await Effect.runPromise(program)
    expect(result).toHaveLength(1)
    expect(result[0].match.entry.path).toBe(RelativePath.make("src/auth.ts"))
    expect(result[0].relevance).toBe(1.0)
  })

  test("re-ranks multiple matches with calibrated relevance and choice winner", async () => {
    const m1 = mockMatch("src/db.ts", 5, "const db = new DatabaseClient();")
    const m2 = mockMatch("src/auth/jwt.ts", 24, "const verified = jwt.verify(token, secret);")
    const m3 = mockMatch("src/logger.ts", 12, "logger.info('checking token');")

    const mockClient = Layer.succeed(
      TypeSafeClient.Service,
      TypeSafeClient.Service.of({
        isConfigured: () => Effect.succeed(true),
        systemOne: () =>
          Effect.succeed(
            new SystemOneResponse({
              model: "jev-latest",
              answers: {
                c1_relevant: new NoulAnswer({ type: "noul", noul: 0.05 }),
                c2_relevant: new NoulAnswer({ type: "noul", noul: 0.95 }),
                c3_relevant: new NoulAnswer({ type: "noul", noul: 0.3 }),
                best_match: new ChoiceAnswer({
                  type: "choice",
                  choice: "c2",
                  probabilities: { c1: 0, c2: 0.98, c3: 0.02, none: 0 },
                  confidence: 0.98,
                }),
              },
            }),
          ),
      }),
    )

    const program = Effect.gen(function* () {
      const rerank = yield* SearchRerank.Service
      return yield* rerank.rerank({
        query: "where jwt token is verified",
        matches: [m1, m2, m3],
      })
    }).pipe(Effect.provide(SearchRerank.locationLayer), Effect.provide(mockClient))

    const result = await Effect.runPromise(program)
    expect(result).toHaveLength(3)
    // m2 should be top candidate
    expect(result[0].match.entry.path).toBe(RelativePath.make("src/auth/jwt.ts"))
    expect(result[0].match.line).toBe(24)
    expect(result[0].relevance).toBe(0.95)
    expect(result[0].isBestMatch).toBe(true)
    // m1 should be last
    expect(result[2].match.entry.path).toBe(RelativePath.make("src/db.ts"))
    expect(result[2].relevance).toBe(0.05)
  })

  test("falls back to original order if TypeSafe fails", async () => {
    const m1 = mockMatch("src/a.ts", 1, "line 1")
    const m2 = mockMatch("src/b.ts", 2, "line 2")

    const failingClient = Layer.succeed(
      TypeSafeClient.Service,
      TypeSafeClient.Service.of({
        isConfigured: () => Effect.succeed(true),
        systemOne: () =>
          Effect.fail(new TypeSafeClient.TypeSafeError({ message: "Network unavailable" })),
      }),
    )

    const program = Effect.gen(function* () {
      const rerank = yield* SearchRerank.Service
      return yield* rerank.rerank({ query: "anything", matches: [m1, m2] })
    }).pipe(Effect.provide(SearchRerank.locationLayer), Effect.provide(failingClient))

    const result = await Effect.runPromise(program)
    expect(result).toHaveLength(2)
    expect(result[0].match.entry.path).toBe(RelativePath.make("src/a.ts"))
    expect(result[1].match.entry.path).toBe(RelativePath.make("src/b.ts"))
  })
})

describe("SemanticFind.Service", () => {
  const sampleFile = `
import express from "express";
import jwt from "jsonwebtoken";

export function setupAuth(app: express.Express) {
  app.post("/login", (req, res) => {
    const { user, pass } = req.body;
    if (!user) return res.status(400).send("user required");
    const token = jwt.sign({ sub: user }, "secret", { expiresIn: "1h" });
    res.json({ token });
  });
}
  `.trim()

  test("finds exact line and extracts snippet when concept exists", async () => {
    const mockClient = Layer.succeed(
      TypeSafeClient.Service,
      TypeSafeClient.Service.of({
        isConfigured: () => Effect.succeed(true),
        systemOne: () =>
          Effect.succeed(
            new SystemOneResponse({
              model: "jev-latest",
              answers: {
                exists: new NoulAnswer({ type: "noul", noul: 0.98 }),
                target_line: new ChoiceAnswer({
                  type: "choice",
                  choice: "L0009",
                  probabilities: { L0009: 0.99, none: 0.01 },
                  confidence: 0.99,
                }),
              },
            }),
          ),
      }),
    )

    const program = Effect.gen(function* () {
      const finder = yield* SemanticFind.Service
      return yield* finder.find({
        path: "src/auth.ts",
        content: sampleFile,
        query: "where token expiration is configured",
      })
    }).pipe(Effect.provide(SemanticFind.locationLayer), Effect.provide(mockClient))

    const result = await Effect.runPromise(program)
    expect(result.exists).toBe(true)
    expect(result.targetLine).toBe(9)
    expect(result.relevance).toBe(0.98)
    expect(result.snippet).toBeDefined()
    expect(result.snippet).toContain("expiresIn: \"1h\"")
  })

  test("returns exists: false when query concept does not exist in file", async () => {
    const mockClient = Layer.succeed(
      TypeSafeClient.Service,
      TypeSafeClient.Service.of({
        isConfigured: () => Effect.succeed(true),
        systemOne: () =>
          Effect.succeed(
            new SystemOneResponse({
              model: "jev-latest",
              answers: {
                exists: new NoulAnswer({ type: "noul", noul: 0.04 }),
                target_line: new ChoiceAnswer({
                  type: "choice",
                  choice: "none",
                  probabilities: { none: 0.99, L0001: 0.01 },
                  confidence: 0.99,
                }),
              },
            }),
          ),
      }),
    )

    const program = Effect.gen(function* () {
      const finder = yield* SemanticFind.Service
      return yield* finder.find({
        path: "src/auth.ts",
        content: sampleFile,
        query: "where postgres connection pool is initialized",
      })
    }).pipe(Effect.provide(SemanticFind.locationLayer), Effect.provide(mockClient))

    const result = await Effect.runPromise(program)
    expect(result.exists).toBe(false)
    expect(result.relevance).toBe(0.04)
    expect(result.targetLine).toBeUndefined()
  })

  test("handles multi-block routing for larger files (> 80 lines)", async () => {
    const lines: string[] = []
    for (let i = 1; i <= 100; i++) {
      if (i === 65) {
        lines.push(`export const MAX_RETRY_COUNT = 5; // Maximum retry attempts`)
      } else {
        lines.push(`const temp_${i} = ${i};`)
      }
    }
    const largeContent = lines.join("\n")

    const mockClient = Layer.succeed(
      TypeSafeClient.Service,
      TypeSafeClient.Service.of({
        isConfigured: () => Effect.succeed(true),
        systemOne: (req: SystemOneRequest) => {
          // Pass 1: block check
          if ("target_block" in req.questions) {
            return Effect.succeed(
              new SystemOneResponse({
                model: "jev-latest",
                answers: {
                  exists: new NoulAnswer({ type: "noul", noul: 0.92 }),
                  target_block: new ChoiceAnswer({
                    type: "choice",
                    choice: "B2", // Block 2 covers lines 31-70
                    probabilities: { B1: 0.05, B2: 0.92, none: 0.03 },
                    confidence: 0.92,
                  }),
                },
              }),
            )
          }
          // Pass 2: line check inside block
          return Effect.succeed(
            new SystemOneResponse({
              model: "jev-latest",
              answers: {
                exists: new NoulAnswer({ type: "noul", noul: 0.96 }),
                target_line: new ChoiceAnswer({
                  type: "choice",
                  choice: "L0065",
                  probabilities: { L0065: 0.98, none: 0.02 },
                  confidence: 0.98,
                }),
              },
            }),
          )
        },
      }),
    )

    const program = Effect.gen(function* () {
      const finder = yield* SemanticFind.Service
      return yield* finder.find({
        path: "src/retry.ts",
        content: largeContent,
        query: "Where is maximum retry attempts defined?",
      })
    }).pipe(Effect.provide(SemanticFind.locationLayer), Effect.provide(mockClient))

    const result = await Effect.runPromise(program)
    expect(result.exists).toBe(true)
    expect(result.targetLine).toBe(65)
    expect(result.snippet).toContain("MAX_RETRY_COUNT = 5")
  })
})
