export * as TypeSafeClient from "./client"

import { makeLocationNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Config } from "../config"
import { Integration } from "../integration"
import { SystemOneRequest, SystemOneResponse } from "./types"

export class TypeSafeError extends Schema.TaggedErrorClass<TypeSafeError>()("TypeSafeError", {
  message: Schema.String,
  status: Schema.Number.pipe(Schema.optional),
}) {}

export interface Interface {
  readonly isConfigured: () => Effect.Effect<boolean>
  readonly systemOne: (
    request: SystemOneRequest,
  ) => Effect.Effect<SystemOneResponse, TypeSafeError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/TypeSafeClient") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const http = yield* HttpClient.HttpClient
    const integrations = yield* Integration.Service

    const getCredentials = Effect.gen(function* () {
      const entries = yield* config.entries()
      const cfg = Config.latest(entries, "typesafe")
      const enabled = cfg?.enabled ?? true
      if (!enabled) return undefined
      let apiKey = cfg?.apiKey
      if (!apiKey) {
        const conn = yield* integrations.connection.active(Integration.ID.make("typesafe")).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (conn) {
          const resolved = yield* integrations.connection.resolve(conn).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (resolved?.type === "key") {
            apiKey = resolved.key
          }
        }
      }
      if (!apiKey) {
        apiKey = process.env.TYPESAFE_API_KEY
      }
      if (!apiKey) return undefined
      const endpoint = cfg?.endpoint ?? process.env.TYPESAFE_ENDPOINT ?? "https://api.typesafe.ai"
      const defaultModel = cfg?.model ?? "jev-latest"
      return { apiKey, endpoint, defaultModel }
    })

    return Service.of({
      isConfigured: Effect.fn("TypeSafeClient.isConfigured")(function* () {
        const creds = yield* getCredentials
        return creds !== undefined
      }),

      systemOne: Effect.fn("TypeSafeClient.systemOne")(function* (req) {
        const creds = yield* getCredentials
        if (!creds) {
          return yield* Effect.fail(new TypeSafeError({ message: "TypeSafe API key is not configured" }))
        }
        const model = req.model ?? creds.defaultModel
        const url = `${creds.endpoint.replace(/\/+$/, "")}/v1/systemone`
        const payload = new SystemOneRequest({
          state: req.state,
          model,
          questions: req.questions,
        })

        const request = yield* HttpClientRequest.post(url).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(creds.apiKey),
          HttpClientRequest.schemaBodyJson(SystemOneRequest)(payload),
          Effect.mapError((err) => new TypeSafeError({ message: `Failed to serialize TypeSafe request: ${err}` })),
        )

        const response = yield* http.execute(request).pipe(
          Effect.mapError((err) => new TypeSafeError({ message: `TypeSafe network error: ${err}` })),
        )

        if (response.status < 200 || response.status >= 300) {
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          return yield* Effect.fail(
            new TypeSafeError({
              message: `TypeSafe API error ${response.status}: ${text}`,
              status: response.status,
            }),
          )
        }

        const decoded = yield* HttpClientResponse.schemaBodyJson(SystemOneResponse)(response).pipe(
          Effect.mapError((err) => new TypeSafeError({ message: `Failed to decode TypeSafe response: ${err}` })),
        )

        return decoded
      }),
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(FetchHttpClient.layer))

export const node = makeLocationNode({ service: Service, layer, deps: [httpClient, Config.node, Integration.node] })
