import { join } from "node:path"

/**
 * Which fixture set to evaluate against. Empty string = the small built-in
 * corpus.json/dataset.json; any other value resolves to
 * src/eval/fixtures/<set>/corpus.json and dataset.json.
 */
const EVAL_FIXTURE_SET = process.env.EVAL_FIXTURE_SET ?? ""

const loadJson = async <T>(name: string): Promise<T> => {
  const path = join(import.meta.dir, "fixtures", EVAL_FIXTURE_SET, name)
  return (await Bun.file(path).json()) as T
}

const evalCollection = (): string =>
  EVAL_FIXTURE_SET ? `document_chunks_eval_${EVAL_FIXTURE_SET}` : "document_chunks_eval"

export { EVAL_FIXTURE_SET, evalCollection, loadJson }
