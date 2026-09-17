export * as ConfigTypeSafe from "./typesafe"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigV2.TypeSafe")({
  apiKey: Schema.String.pipe(Schema.optional).annotate({
    description: "TypeSafe API key for pre-pass classification and skill suggestion",
  }),
  endpoint: Schema.String.pipe(Schema.optional).annotate({
    description: "Custom endpoint URL for TypeSafe API (defaults to https://api.typesafe.ai)",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "TypeSafe model to use (defaults to jev-latest)",
  }),
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Whether TypeSafe pre-pass classification is enabled (defaults to true if apiKey or env is present)",
  }),
}) {}
