export * as TypeSafeTypes from "./types"

import { Schema } from "effect"

export class NoulCriteria extends Schema.Class<NoulCriteria>("TypeSafe.NoulCriteria")({
  true: Schema.String.pipe(Schema.optional),
  false: Schema.String.pipe(Schema.optional),
}) {}

export class NoulQuestion extends Schema.Class<NoulQuestion>("TypeSafe.NoulQuestion")({
  type: Schema.Literal("noul"),
  instructions: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)]),
  criteria: NoulCriteria.pipe(Schema.optional),
}) {}

export class ChoiceQuestion extends Schema.Class<ChoiceQuestion>("TypeSafe.ChoiceQuestion")({
  type: Schema.Literal("choice"),
  instructions: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)]),
  criteria: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
}) {}

export class ScoreQuestion extends Schema.Class<ScoreQuestion>("TypeSafe.ScoreQuestion")({
  type: Schema.Literal("score"),
  instructions: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)]),
  criteria: Schema.Array(Schema.String),
}) {}

export const Question = Schema.Union([NoulQuestion, ChoiceQuestion, ScoreQuestion])
export type Question = typeof Question.Type

export class SystemOneRequest extends Schema.Class<SystemOneRequest>("TypeSafe.SystemOneRequest")({
  state: Schema.Unknown,
  model: Schema.String.pipe(Schema.optional),
  questions: Schema.Record(Schema.String, Question),
}) {}

export class NoulAnswer extends Schema.Class<NoulAnswer>("TypeSafe.NoulAnswer")({
  type: Schema.Literal("noul"),
  noul: Schema.Number,
}) {}

export class ChoiceAnswer extends Schema.Class<ChoiceAnswer>("TypeSafe.ChoiceAnswer")({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number,
}) {}

export class ScoreAnswer extends Schema.Class<ScoreAnswer>("TypeSafe.ScoreAnswer")({
  type: Schema.Literal("score"),
  score: Schema.Number,
  legend: Schema.Record(Schema.String, Schema.String),
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number,
}) {}

export const Answer = Schema.Union([NoulAnswer, ChoiceAnswer, ScoreAnswer])
export type Answer = typeof Answer.Type

export class Usage extends Schema.Class<Usage>("TypeSafe.Usage")({
  input_tokens: Schema.Number.pipe(Schema.optional),
  output_tokens: Schema.Number.pipe(Schema.optional),
}) {}

export class SystemOneResponse extends Schema.Class<SystemOneResponse>("TypeSafe.SystemOneResponse")({
  model: Schema.String,
  answers: Schema.Record(Schema.String, Answer),
  usage: Usage.pipe(Schema.optional),
}) {}
