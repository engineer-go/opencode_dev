import { Effect } from "effect"
import { define } from "../internal"
import { Integration } from "../../integration"
import { ProviderV2 } from "../../provider"

export const TypeSafePlugin = define({
  id: "typesafe",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.integration.transform((draft) => {
      draft.update(Integration.ID.make("typesafe"), (integration) => {
        integration.name = "TypeSafe"
      })
      draft.method.update({
        integrationID: Integration.ID.make("typesafe"),
        method: { type: "key", label: "TypeSafe API Key" },
      })
      draft.method.update({
        integrationID: Integration.ID.make("typesafe"),
        method: { type: "env", names: ["TYPESAFE_API_KEY"] },
      })
    })
    yield* ctx.catalog.transform((draft) => {
      draft.provider.update(ProviderV2.ID.make("typesafe"), (provider) => {
        provider.name = "TypeSafe"
        provider.integrationID = Integration.ID.make("typesafe")
      })
    })
  }),
})
