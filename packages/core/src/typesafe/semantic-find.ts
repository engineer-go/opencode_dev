export * as SemanticFind from "./semantic-find"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer } from "effect"
import { TypeSafeClient } from "./client"
import { ChoiceAnswer, ChoiceQuestion, NoulAnswer, NoulQuestion, SystemOneRequest } from "./types"

const SINGLE_PASS_LINE_LIMIT = 80
const BLOCK_SIZE = 40
const BLOCK_OVERLAP = 10
const EXISTS_THRESHOLD = 0.35
const SNIPPET_PADDING = 5

export interface SemanticFindInput {
  readonly path: string
  readonly content: string
  readonly query: string
  readonly lineStart?: number
  readonly lineEnd?: number
}

export interface SemanticFindResult {
  readonly exists: boolean
  readonly relevance: number
  readonly targetLine?: number
  readonly confidence?: number
  readonly snippet?: string
  readonly reason?: string
}

export interface Interface {
  readonly find: (input: SemanticFindInput) => Effect.Effect<SemanticFindResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SemanticFind") {}

const formatLineId = (lineNum: number) => `L${String(lineNum).padStart(4, "0")}`
const parseLineId = (id: string) => {
  const match = id.match(/L(\d+)/)
  return match ? parseInt(match[1], 10) : undefined
}

const buildSnippet = (allLines: string[], targetLine: number): string => {
  const start = Math.max(1, targetLine - SNIPPET_PADDING)
  const end = Math.min(allLines.length, targetLine + SNIPPET_PADDING)
  return allLines
    .slice(start - 1, end)
    .map((line, idx) => {
      const num = start + idx
      const prefix = num === targetLine ? ">" : " "
      return `${prefix} ${String(num).padStart(4, " ")}: ${line}`
    })
    .join("\n")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const client = yield* TypeSafeClient.Service

    const runFind = (input: SemanticFindInput) =>
      Effect.gen(function* () {
        const isConfigured = yield* client.isConfigured()
        if (!isConfigured) {
          return {
            exists: false,
            relevance: 0,
            reason: "TypeSafe is not configured",
          }
        }

        const allLines = input.content.split("\n")
        const start = Math.max(1, input.lineStart ?? 1)
        const end = Math.min(allLines.length, input.lineEnd ?? allLines.length)
        const slicedLines = allLines.slice(start - 1, end)

        if (slicedLines.length === 0 || !input.query.trim()) {
          return {
            exists: false,
            relevance: 0,
            reason: "Empty content or query",
          }
        }

        yield* Effect.logInfo("TypeSafe semantic find evaluating", {
          path: input.path,
          query: input.query.slice(0, 60),
          linesCount: slicedLines.length,
        })

        // Fast path: <= 80 lines, single pass line-level search
        if (slicedLines.length <= SINGLE_PASS_LINE_LIMIT) {
          return yield* searchLines({
            allLines,
            startLine: start,
            lines: slicedLines,
            query: input.query,
            path: input.path,
            client,
          })
        }

        // 2-Pass search for larger files: Block routing -> line refinement
        const blocks: Array<{
          id: string
          startLine: number
          endLine: number
          summary: string
          lines: string[]
        }> = []

        let currStart = start
        let blockIndex = 1
        while (currStart <= end) {
          const currEnd = Math.min(end, currStart + BLOCK_SIZE - 1)
          const bLines = allLines.slice(currStart - 1, currEnd)
          const firstNonEmpty = bLines.find((l) => l.trim().length > 0)?.trim().slice(0, 60) ?? ""
          blocks.push({
            id: `B${blockIndex}`,
            startLine: currStart,
            endLine: currEnd,
            summary: `Lines ${currStart}-${currEnd}: ${firstNonEmpty}`,
            lines: bLines,
          })
          blockIndex++
          if (currEnd >= end) break
          currStart = currEnd - BLOCK_OVERLAP + 1
        }

        const blockCriteria: Record<string, string | null> = {}
        for (const block of blocks) {
          blockCriteria[block.id] = block.summary
        }
        blockCriteria["none"] = "None of the blocks contain the requested logic or setting"

        const pass1Response = yield* client.systemOne(
          new SystemOneRequest({
            state: {
              query: input.query,
              file: input.path,
              blocks: blocks.map((b) => ({
                id: b.id,
                lines: `Lines ${b.startLine}-${b.endLine}`,
                preview: b.summary,
              })),
            },
            questions: {
              exists: new NoulQuestion({
                type: "noul",
                instructions: `Does any block in the file contain code that directly answers or implements the query: "${input.query}"?`,
              }),
              target_block: new ChoiceQuestion({
                type: "choice",
                instructions: `Which block contains the logic, definition, or setting asked in the query: "${input.query}"?`,
                criteria: blockCriteria,
              }),
            },
          }),
        )

        const existsAns = pass1Response.answers["exists"]
        const existsNoul = existsAns instanceof NoulAnswer ? existsAns.noul : 0
        const blockAns = pass1Response.answers["target_block"]
        const blockChoice = blockAns instanceof ChoiceAnswer ? blockAns.choice : "none"

        if (existsNoul < EXISTS_THRESHOLD || blockChoice === "none") {
          yield* Effect.logInfo("TypeSafe semantic find: not found in blocks", {
            path: input.path,
            exists: existsNoul,
          })
          return {
            exists: false,
            relevance: existsNoul,
            reason: "Target concept not found in file",
          }
        }

        const winningBlock = blocks.find((b) => b.id === blockChoice)
        if (!winningBlock) {
          return {
            exists: false,
            relevance: existsNoul,
            reason: "Block resolution error",
          }
        }

        // Pass 2: Line search inside winning block
        return yield* searchLines({
          allLines,
          startLine: winningBlock.startLine,
          lines: winningBlock.lines,
          query: input.query,
          path: input.path,
          client,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("TypeSafe semantic find failed", { error }).pipe(
            Effect.as({
              exists: false,
              relevance: 0,
              reason: `Semantic find error: ${error}`,
            }),
          ),
        ),
      )

    return Service.of({
      find: Effect.fn("SemanticFind.find")(function* (input) {
        return yield* runFind(input)
      }),
    })
  }),
)

const searchLines = ({
  allLines,
  startLine,
  lines,
  query,
  path,
  client,
}: {
  allLines: string[]
  startLine: number
  lines: string[]
  query: string
  path: string
  client: TypeSafeClient.Interface
}) =>
  Effect.gen(function* () {
    const criteria: Record<string, string | null> = {}
    const taggedLines: string[] = []

    lines.forEach((line, idx) => {
      const lineNum = startLine + idx
      const id = formatLineId(lineNum)
      taggedLines.push(`${id}: ${line}`)
      if (line.trim().length > 0) {
        criteria[id] = `${id}: ${line.trim().slice(0, 80)}`
      }
    })
    criteria["none"] = "Not found or not addressed in this file section"

    const response = yield* client.systemOne(
      new SystemOneRequest({
        state: {
          query,
          file: path,
          lines: taggedLines.join("\n"),
        },
        questions: {
          exists: new NoulQuestion({
            type: "noul",
            instructions: `Does the file contain code that directly implements, defines, or answers the query: "${query}"?`,
          }),
          target_line: new ChoiceQuestion({
            type: "choice",
            instructions: `Which line number contains the logic, definition, or setting asked in the query: "${query}"?`,
            criteria,
          }),
        },
      }),
    )

    const existsAns = response.answers["exists"]
    const existsNoul = existsAns instanceof NoulAnswer ? existsAns.noul : 0
    const lineAns = response.answers["target_line"]
    const lineChoice = lineAns instanceof ChoiceAnswer ? lineAns.choice : "none"
    const confidence = lineAns instanceof ChoiceAnswer ? lineAns.confidence : undefined

    if (existsNoul < EXISTS_THRESHOLD || lineChoice === "none") {
      yield* Effect.logInfo("TypeSafe semantic find: target line not found", {
        path,
        exists: existsNoul,
      })
      return {
        exists: false,
        relevance: existsNoul,
        reason: "Target concept not found in file",
      }
    }

    const targetLine = parseLineId(lineChoice)
    if (!targetLine) {
      return {
        exists: false,
        relevance: existsNoul,
        reason: "Unable to parse target line",
      }
    }

    const snippet = buildSnippet(allLines, targetLine)

    yield* Effect.logInfo("TypeSafe semantic find winner", {
      path,
      targetLine,
      relevance: existsNoul,
      confidence,
    })

    return {
      exists: true,
      relevance: existsNoul,
      targetLine,
      confidence,
      snippet,
    }
  })

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [TypeSafeClient.node] })
