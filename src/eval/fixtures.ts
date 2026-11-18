import { join } from "node:path"

/**
 * Evaluation fixture directory under src/eval/fixtures.
 * The built-in smoke set verifies wiring only; it is not a quality benchmark.
 */
const EVAL_FIXTURE_SET = process.env.EVAL_FIXTURE_SET || "smoke"
if (!/^[a-zA-Z0-9_-]+$/.test(EVAL_FIXTURE_SET)) throw new Error("Invalid EVAL_FIXTURE_SET")

const fixtureDirectory = (): string => join(import.meta.dir, "fixtures", EVAL_FIXTURE_SET)

const loadJson = async <T>(name: string): Promise<T> => {
  return (await Bun.file(join(fixtureDirectory(), name)).json()) as T
}

const evalCollection = (): string =>
  EVAL_FIXTURE_SET ? `document_chunks_eval_${EVAL_FIXTURE_SET}` : "document_chunks_eval"

export { EVAL_FIXTURE_SET, evalCollection, fixtureDirectory, loadJson }
