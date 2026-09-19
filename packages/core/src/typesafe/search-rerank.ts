export * as SearchRerank from "./search-rerank"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer } from "effect"
import { FileSystem } from "../filesystem"
import { TypeSafeClient } from "./client"
import { ChoiceAnswer, ChoiceQuestion, NoulAnswer, NoulQuestion, SystemOneRequest } from "./types"

const MAX_RERANK_CANDIDATES = 25

export interface RankedMatch {
  readonly match: FileSystem.Match
  readonly relevance: number // Calibrated 0.0 - 1.0
  readonly score: number // Combined rank score
  readonly isBestMatch?: boolean
  readonly confidence?: number
}

export interface SearchRerankInput {
  readonly query: string
  readonly matches: readonly FileSystem.Match[]
}

export interface Interface {
  readonly rerank: (input: SearchRerankInput) => Effect.Effect<readonly RankedMatch[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SearchRerank") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const client = yield* TypeSafeClient.Service

    const runRerank = (input: SearchRerankInput) =>
      Effect.gen(function* () {
        const { query, matches } = input
        if (matches.length === 0) return []
        if (matches.length === 1) {
          return [{ match: matches[0], relevance: 1.0, score: 1.0, isBestMatch: true }]
        }

        const isConfigured = yield* client.isConfigured()
        if (!isConfigured || !query.trim()) {
          return matches.map((match) => ({ match, relevance: 1.0, score: 1.0 }))
        }

        const toRerank = matches.slice(0, MAX_RERANK_CANDIDATES)
        const rest = matches.slice(MAX_RERANK_CANDIDATES)

        const candidates = toRerank.map((match, index) => ({
          id: `c${index + 1}`,
          match,
          file: match.entry.path,
          line: match.line,
          snippet: match.text.trim().slice(0, 160),
        }))

        const criteria: Record<string, string | null> = {}
        const questions: Record<string, NoulQuestion | ChoiceQuestion> = {}

        for (const candidate of candidates) {
          criteria[candidate.id] = `${candidate.file}:${candidate.line} — ${candidate.snippet.slice(0, 80)}`
          questions[`${candidate.id}_relevant`] = new NoulQuestion({
            type: "noul",
            instructions: `Does candidate ${candidate.id} (${candidate.file}:${candidate.line}) directly implement, address, or match the search query: "${query}"?`,
          })
        }
        criteria["none"] = "None of the candidates are relevant to the query"

        questions["best_match"] = new ChoiceQuestion({
          type: "choice",
          instructions: `Which candidate is the most direct, accurate, and relevant match for the query: "${query}"?`,
          criteria,
        })

        yield* Effect.logInfo("TypeSafe search re-ranking started", {
          query: query.slice(0, 60),
          candidatesCount: candidates.length,
          totalMatches: matches.length,
        })

        const response = yield* client.systemOne(
          new SystemOneRequest({
            state: {
              query,
              candidates: candidates.map((c) => ({
                id: c.id,
                file: c.file,
                line: c.line,
                snippet: c.snippet,
              })),
            },
            questions,
          }),
          { source: "search-rerank" },
        )

        const bestMatchAns = response.answers["best_match"]
        const bestCandidateId = bestMatchAns instanceof ChoiceAnswer ? bestMatchAns.choice : undefined
        const bestConfidence = bestMatchAns instanceof ChoiceAnswer ? bestMatchAns.confidence : 0

        const rankedCandidates: RankedMatch[] = candidates.map((c) => {
          const noulAns = response.answers[`${c.id}_relevant`]
          const relevance = noulAns instanceof NoulAnswer ? noulAns.noul : 0.5
          const isBestMatch = c.id === bestCandidateId
          const confidence = isBestMatch ? bestConfidence : undefined
          const score = isBestMatch
            ? Math.min(1.0, relevance * 0.7 + 0.3 * (confidence ?? 1.0))
            : relevance * 0.7

          return {
            match: c.match,
            relevance,
            score,
            isBestMatch,
            confidence,
          }
        })

        rankedCandidates.sort((a, b) => b.score - a.score)

        const remainingRanked: RankedMatch[] = rest.map((m) => ({
          match: m,
          relevance: 0.1,
          score: 0.1,
        }))

        const allRanked = [...rankedCandidates, ...remainingRanked]

        yield* Effect.logInfo("TypeSafe search re-ranking complete", {
          query: query.slice(0, 60),
          topCandidate: allRanked[0]?.match.entry.path,
          topLine: allRanked[0]?.match.line,
          topRelevance: allRanked[0]?.relevance,
          topScore: allRanked[0]?.score,
        })

        return allRanked
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("TypeSafe search re-ranking failed, proceeding with original matches", {
            error,
          }).pipe(Effect.as(input.matches.map((match) => ({ match, relevance: 1.0, score: 1.0 })))),
        ),
      )

    return Service.of({
      rerank: Effect.fn("SearchRerank.rerank")(function* (input) {
        return yield* runRerank(input)
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [TypeSafeClient.node] })
