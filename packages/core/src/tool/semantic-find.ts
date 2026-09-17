export * as SemanticFindTool from "./semantic-find"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { RelativePath } from "../schema"
import { SemanticFind } from "../typesafe/semantic-find"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "semantic_find"

export const Input = Schema.Struct({
  path: RelativePath.annotate({
    description: "Relative path of the file to search within (e.g. 'src/auth/jwt.ts')",
  }),
  query: Schema.String.annotate({
    description: "Natural language query describing the logic, configuration, or function to locate",
  }),
  line_start: Schema.optional(Schema.Number).annotate({
    description: "Optional 1-based start line to bound the search window",
  }),
  line_end: Schema.optional(Schema.Number).annotate({
    description: "Optional 1-based end line to bound the search window",
  }),
})

export const Output = Schema.Struct({
  path: Schema.String,
  exists: Schema.Boolean,
  relevance: Schema.Number,
  line: Schema.optional(Schema.Number),
  confidence: Schema.optional(Schema.Number),
  snippet: Schema.optional(Schema.String),
  message: Schema.String,
})

const toModelOutputText = (output: typeof Output.Type) => {
  if (!output.exists) {
    return [
      `Target concept NOT found in ${output.path} (relevance score: ${Math.round(output.relevance * 100)}%).`,
      output.message,
      `Do NOT assume or hallucinate this logic in this file.`,
    ].join("\n")
  }
  return [
    `Found in ${output.path} at Line ${output.line} (relevance: ${Math.round(output.relevance * 100)}%, confidence: ${Math.round((output.confidence ?? 1) * 100)}%):`,
    "",
    output.snippet ?? "",
  ].join("\n")
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const semanticFind = yield* SemanticFind.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Semantically search inside a file to pinpoint the exact line and snippet implementing a concept, setting, or error handler without hallucinating edits. Returns existence probability (0.0 to 1.0), exact target line, confidence, and contextual snippet.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutputText(output),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.path],
                save: ["*"],
                metadata: {
                  path: input.path,
                  query: input.query,
                  line_start: input.line_start,
                  line_end: input.line_end,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const target = path.resolve(location.directory, input.path)
              const content = yield* fs.readFileString(target).pipe(
                Effect.mapError(
                  (err) => new ToolFailure({ message: `Unable to read file ${input.path}: ${err}` }),
                ),
              )

              const result = yield* semanticFind.find({
                path: input.path,
                content,
                query: input.query,
                lineStart: input.line_start,
                lineEnd: input.line_end,
              })

              return Output.make({
                path: input.path,
                exists: result.exists,
                relevance: result.relevance,
                line: result.targetLine,
                confidence: result.confidence,
                snippet: result.snippet,
                message: result.exists
                  ? `Found target concept in ${input.path} at Line ${result.targetLine}`
                  : result.reason ?? `The file does not implement or address "${input.query}".`,
              })
            }).pipe(
              Effect.catch((err) =>
                err instanceof ToolFailure
                  ? Effect.fail(err)
                  : Effect.fail(new ToolFailure({ message: `Semantic find failed on ${input.path}: ${err}` })),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/semantic-find",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, Location.node, PermissionV2.node, SemanticFind.node],
})
