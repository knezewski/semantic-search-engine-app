import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { BM25_B, BM25_K1, bm25Scores, buildTermIndex, rankTop, type TermIndex, tokenizeWords } from "./bm25"
import type { EvalDocument, EvalQuery } from "./types"

/**
 * Builds a larger eval fixture set from an unzipped BEIR dataset (e.g. fiqa.zip).
 *
 * Corpus = gold documents of the test split + hard negatives. A hard negative is a
 * non-relevant document from the full BEIR corpus that BM25 ranks highest for a query.
 *
 * Usage: bun src/eval/build-beir-fixtures.ts <beirDir> <outDir>
 * Run:   EVAL_FIXTURE_SET=<outDirName> bun run eval
 */

const SPLIT = "test"
const NEGATIVES_PER_QUERY = 3

interface BeirDocument {
  _id: string
  title?: string
  text: string
}

interface BeirQuery {
  _id: string
  text: string
}

const readJsonl = async <T>(path: string): Promise<T[]> =>
  (await Bun.file(path).text())
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as T)

const readQrels = async (path: string): Promise<Map<string, Set<string>>> => {
  const qrels = new Map<string, Set<string>>()
  const lines = (await Bun.file(path).text()).split("\n").slice(1)
  for (const line of lines) {
    const [queryId, corpusId, score] = line.split("\t")
    if (!queryId || !corpusId || !(Number(score) > 0)) continue
    const gold = qrels.get(queryId) ?? new Set<string>()
    gold.add(corpusId)
    qrels.set(queryId, gold)
  }
  return qrels
}

const topNonRelevant = (
  index: TermIndex,
  documents: BeirDocument[],
  queryText: string,
  relevant: Set<string>,
  limit: number
): string[] => {
  const scores = bm25Scores(index, tokenizeWords(queryText))

  const picked: string[] = []
  for (const docIndex of rankTop(scores, Number.POSITIVE_INFINITY)) {
    const document = documents[docIndex]
    if (!document || relevant.has(document._id)) continue
    picked.push(document._id)
    if (picked.length === limit) break
  }
  return picked
}

const run = async (): Promise<void> => {
  const [beirDir, outDir] = Bun.argv.slice(2)
  if (!beirDir || !outDir) {
    throw new Error("Usage: bun src/eval/build-beir-fixtures.ts <beirDir> <outDir>")
  }

  const documents = await readJsonl<BeirDocument>(join(beirDir, "corpus.jsonl"))
  const queries = await readJsonl<BeirQuery>(join(beirDir, "queries.jsonl"))
  const qrels = await readQrels(join(beirDir, "qrels", `${SPLIT}.tsv`))

  const documentById = new Map(documents.map(document => [document._id, document]))
  for (const gold of qrels.values()) {
    for (const id of gold) {
      if ((documentById.get(id)?.text.trim() ?? "") === "") gold.delete(id)
    }
  }

  const evalQueries = queries.filter(query => (qrels.get(query._id)?.size ?? 0) > 0)
  const goldIds = new Set<string>()
  for (const gold of qrels.values()) {
    for (const id of gold) goldIds.add(id)
  }

  const index = buildTermIndex(
    documents.map(document => `${document.title ?? ""} ${document.text}`),
    tokenizeWords
  )
  const negativeIds = new Set<string>()
  for (const query of evalQueries) {
    const relevant = qrels.get(query._id) ?? new Set<string>()
    for (const id of topNonRelevant(index, documents, query.text, relevant, NEGATIVES_PER_QUERY)) {
      negativeIds.add(id)
    }
  }

  const corpusIds = [...new Set([...goldIds, ...negativeIds])]
  const corpus: EvalDocument[] = corpusIds.map(id => {
    const document = documentById.get(id)
    if (!document) throw new Error(`Document ${id} missing from BEIR corpus`)
    return {
      id: `fiqa-${id}`,
      title: document.title ?? "",
      text: document.text,
      source: `beir/fiqa/${id}`
    }
  })

  const dataset: EvalQuery[] = evalQueries.map(query => ({
    id: `fiqa-q${query._id}`,
    query: query.text,
    relevantDocumentIds: [...(qrels.get(query._id) ?? [])].map(id => `fiqa-${id}`)
  }))

  const relevantPairs = dataset.reduce((sum, query) => sum + query.relevantDocumentIds.length, 0)
  const meta = {
    source: `BEIR fiqa, ${SPLIT} split`,
    documents: corpus.length,
    goldDocuments: goldIds.size,
    hardNegativeDocuments: corpusIds.filter(id => !goldIds.has(id)).length,
    queries: dataset.length,
    avgRelevantPerQuery: Number((relevantPairs / dataset.length).toFixed(2)),
    negativesPerQuery: NEGATIVES_PER_QUERY,
    bm25: { k1: BM25_K1, b: BM25_B, tokenizer: "lowercase [a-z0-9]+" }
  }

  await mkdir(outDir, { recursive: true })
  await Bun.write(join(outDir, "corpus.json"), `${JSON.stringify(corpus, null, 2)}\n`)
  await Bun.write(join(outDir, "dataset.json"), `${JSON.stringify(dataset, null, 2)}\n`)
  await Bun.write(join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`)
  console.log(JSON.stringify(meta, null, 2))
  console.log(`Wrote fixture set to ${outDir}`)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
