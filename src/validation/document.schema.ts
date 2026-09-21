import { type } from "arktype"

const documentCreateSchema = type({
  title: "0 < string <= 300",
  text: "0 < string <= 100000",
  "source?": "0 < string <= 500"
})

type DocumentCreateInput = typeof documentCreateSchema.infer

export type { DocumentCreateInput }
export { documentCreateSchema }
