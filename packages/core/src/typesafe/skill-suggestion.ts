export * as SkillSuggestion from "./skill-suggestion"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer } from "effect"
import { SkillV2 } from "../skill"
import { TypeSafeClient } from "./client"
import { ChoiceAnswer, ChoiceQuestion, NoulAnswer, NoulQuestion, SystemOneRequest } from "./types"

const SHORTLIST = 3
const EXCERPT_CHARS = 700
const GATE_THRESHOLD = 0.3
const FITS_THRESHOLD = 0.3

const CHOICE_INSTRUCTIONS =
  "Which of these skills, if any, is the right one to load to help with the user's latest request?"

const RERANK_INSTRUCTIONS =
  "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name."

const GATE_QUESTIONS = {
  acts_on_user_system: new NoulQuestion({
    type: "noul",
    instructions:
      "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
  }),
  would_follow_documented_procedure: new NoulQuestion({
    type: "noul",
    instructions:
      "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
  }),
  prose_suffices: new NoulQuestion({
    type: "noul",
    instructions:
      "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
  }),
}

export const suggestionBlock = (winner?: string): string => {
  const body = winner
    ? `Relevant to the current request: ${winner}. Ignore this if it does not fit what the user actually asked for.`
    : "No skill in the roster appears relevant to this request."
  return `\n\n<skill_relevance>\n${body}\n</skill_relevance>`
}

export interface Interface {
  readonly suggest: (input: {
    readonly request: string
    readonly skills: ReadonlyArray<SkillV2.Info>
  }) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SkillSuggestion") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const client = yield* TypeSafeClient.Service

    const runSuggestion = (requestText: string, skills: ReadonlyArray<SkillV2.Info>) =>
      Effect.gen(function* () {
        const configured = yield* client.isConfigured()
        if (!configured) return undefined
        if (skills.length === 0 || !requestText.trim()) return undefined

        // Pass 1: Wide scan across all available skills + gate checks
        yield* Effect.logInfo("TypeSafe skill suggestion evaluating", {
          skillsCount: skills.length,
          request: requestText.slice(0, 60),
        })

        const criteria: Record<string, string | null> = {}
        for (const skill of skills) {
          criteria[skill.name] = skill.description ?? skill.name
        }

        const pass1Questions = {
          which: new ChoiceQuestion({
            type: "choice",
            instructions: CHOICE_INSTRUCTIONS,
            criteria,
          }),
          "gate::acts_on_user_system": GATE_QUESTIONS.acts_on_user_system,
          "gate::would_follow_documented_procedure": GATE_QUESTIONS.would_follow_documented_procedure,
          "gate::prose_suffices": GATE_QUESTIONS.prose_suffices,
        }

        const pass1Response = yield* client.systemOne(
          new SystemOneRequest({
            state: { request: requestText, recent_context: "" },
            questions: pass1Questions,
          }),
          { source: "skill-suggestion/pass1" },
        )

        const acts = pass1Response.answers["gate::acts_on_user_system"]
        const proc = pass1Response.answers["gate::would_follow_documented_procedure"]
        const prose = pass1Response.answers["gate::prose_suffices"]

        const actsVal = acts instanceof NoulAnswer ? acts.noul : 0
        const procVal = proc instanceof NoulAnswer ? proc.noul : 0
        const proseVal = prose instanceof NoulAnswer ? prose.noul : 0
        const gate = (actsVal + procVal + (1.0 - proseVal)) / 3.0

        if (gate < GATE_THRESHOLD) {
          yield* Effect.logInfo("TypeSafe Pass 1: request does not need a skill", { gate })
          return undefined
        }

        const whichAns = pass1Response.answers["which"]
        const probs = whichAns instanceof ChoiceAnswer ? whichAns.probabilities : {}

        const ranked = [...skills].sort((a, b) => (probs[b.name] ?? 0) - (probs[a.name] ?? 0))
        const candidates = ranked.slice(0, SHORTLIST)
        if (candidates.length === 0) return undefined

        yield* Effect.logInfo("TypeSafe Pass 1 top candidates", {
          candidates: candidates.map((c) => c.name),
        })

        // Pass 2: Rerank top 3 with full SKILL.md excerpts and fits verification
        const pass2Criteria: Record<string, string | null> = {}
        const pass2Questions: Record<string, ChoiceQuestion | NoulQuestion> = {}

        for (const candidate of candidates) {
          const bodyExcerpt = candidate.content.trim().slice(0, EXCERPT_CHARS)
          pass2Criteria[candidate.name] = `${candidate.description ?? candidate.name} — ${bodyExcerpt}`
          pass2Questions[`fits::${candidate.name}`] = new NoulQuestion({
            type: "noul",
            instructions: `Does the skill '${candidate.name}' do the specific thing the user's request asks for? It is described as: ${candidate.description ?? candidate.name}`,
          })
        }

        pass2Questions["which"] = new ChoiceQuestion({
          type: "choice",
          instructions: RERANK_INSTRUCTIONS,
          criteria: pass2Criteria,
        })

        const pass2Response = yield* client.systemOne(
          new SystemOneRequest({
            state: { request: requestText, recent_context: "" },
            questions: pass2Questions,
          }),
          { source: "skill-suggestion/pass2" },
        )

        let bestFit = 0
        for (const candidate of candidates) {
          const fitAns = pass2Response.answers[`fits::${candidate.name}`]
          if (fitAns instanceof NoulAnswer && fitAns.noul > bestFit) {
            bestFit = fitAns.noul
          }
        }

        if (bestFit < FITS_THRESHOLD) {
          yield* Effect.logInfo("TypeSafe Pass 2: no candidate met fit threshold", { bestFit })
          return undefined
        }

        const p2Which = pass2Response.answers["which"]
        const winner =
          p2Which instanceof ChoiceAnswer && p2Which.choice ? p2Which.choice : candidates[0]?.name

        yield* Effect.logInfo("TypeSafe skill suggestion winner", {
          winner,
          bestFit,
        })

        return winner
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("TypeSafe skill suggestion failed, proceeding without suggestion", {
            error,
          }).pipe(Effect.as(undefined)),
        ),
      )

    return Service.of({
      suggest: Effect.fn("SkillSuggestion.suggest")(function* (input) {
        return (yield* runSuggestion(input.request, input.skills)) as string | undefined
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [TypeSafeClient.node] })
