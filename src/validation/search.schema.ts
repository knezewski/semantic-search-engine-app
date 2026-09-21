import { type } from "arktype"

const searchRequestSchema = type({
  query: "0 < string <= 2000",
  "limit?": "1 <= number.integer <= 50",
  "source?": "0 < string <= 500",
  "scoreThreshold?": "0 <= number <= 1",
  "mode?": "'dense' | 'hybrid' | 'rerank'"
})

type SearchRequestInput = typeof searchRequestSchema.infer

export type { SearchRequestInput }
export { searchRequestSchema }
