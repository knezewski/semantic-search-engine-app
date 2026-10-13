import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { getEmbeddingService } from "../services/embedding"
import { type SearchMode, SearchService } from "../services/search"
import { VectorService } from "../services/vector"
import { aggregate, type QueryScore, scoreQuery } from "./metrics"
import type { EvalDocument, EvalQuery } from "./types"
import { EVAL_FIXTURE_SET, evalCollection, loadJson } from "./fixtures"
import { indexCorpus, round } from "./helpers"

const EVAL_COLLECTION = evalCollection()
const SEARCH_LIMIT = 10
const MODES: SearchMode[] = ["dense", "hybrid", "rerank"]

const toMetrics = (summary: QueryScore) => ({
  hitAt1: round(summary.hitAt1),
  hitAt5: round(summary.hitAt5),
  hitAt10: round(summary.hitAt10),
  recallAt1: round(summary.recallAt1),
  recallAt5: round(summary.recallAt5),
  recallAt10: round(summary.recallAt10),
  mrr: round(summary.mrr),
  ndcgAt10: round(summary.ndcgAt10)
})

const evaluateMode = async (
  search: SearchService,
  dataset: EvalQuery[],
  mode: SearchMode
): Promise<{
  metrics: ReturnType<typeof toMetrics>
  queries: Array<{ id: string; query: string; hitAt5: number; mrr: number; ndcgAt10: number }>
}> => {
  const perQuery: Array<QueryScore & { id: string; query: string }> = []

  for (const item of dataset) {
    const hits = await search.search({ query: item.query, limit: SEARCH_LIMIT, mode })
    perQuery.push({
      id: item.id,
      query: item.query,
      ...scoreQuery(
        hits.map(hit => hit.documentId),
        item.relevantDocumentIds
      )
    })
  }

  return {
    metrics: toMetrics(aggregate(perQuery)),
    queries: perQuery.map(item => ({
      id: item.id,
      query: item.query,
      hitAt5: item.hitAt5,
      mrr: round(item.mrr),
      ndcgAt10: round(item.ndcgAt10)
    }))
  }
}

const run = async (): Promise<void> => {
  const corpus = await loadJson<EvalDocument[]>("corpus.json")
  const dataset = await loadJson<EvalQuery[]>("dataset.json")

  await verifyQdrantConnection()
  const qdrant = getQdrantClient()
  const vectors = new VectorService(qdrant, EVAL_COLLECTION)
  const search = new SearchService(qdrant, EVAL_COLLECTION)

  console.log(`Indexing ${corpus.length} eval documents into ${EVAL_COLLECTION}`)
  await indexCorpus(corpus, vectors, EVAL_COLLECTION)

  const byMode: Record<string, Awaited<ReturnType<typeof evaluateMode>>> = {}
  for (const mode of MODES) {
    console.log(`Evaluating mode=${mode}`)
    byMode[mode] = await evaluateMode(search, dataset, mode)
  }

  const results = {
    collection: EVAL_COLLECTION,
    model: getEmbeddingService().modelId,
    documents: corpus.length,
    queries: dataset.length,
    metrics: {
      dense: byMode.dense?.metrics,
      hybrid: byMode.hybrid?.metrics,
      rerank: byMode.rerank?.metrics
    },
    queryResults: dataset.map(item => ({
      id: item.id,
      query: item.query,
      dense: byMode.dense?.queries.find(row => row.id === item.id),
      hybrid: byMode.hybrid?.queries.find(row => row.id === item.id),
      rerank: byMode.rerank?.queries.find(row => row.id === item.id)
    }))
  }

  const outPath = join(
    import.meta.dir,
    EVAL_FIXTURE_SET ? `../../eval-results-${EVAL_FIXTURE_SET}.json` : "../../eval-results.json"
  )
  await mkdir(dirname(outPath), { recursive: true })
  await Bun.write(outPath, `${JSON.stringify(results, null, 2)}\n`)

  console.log(JSON.stringify(results.metrics, null, 2))
  console.log(`Wrote ${outPath}`)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
