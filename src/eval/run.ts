import { env } from "../config/env"
import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { type SearchMode, SearchService } from "../services/search"
import { VectorService } from "../services/vector"
import { indexCorpus } from "./helpers"
import { compareQueries, type EvalQueryResult, makeQueryResult, summarizeQueries } from "./report"
import { createEvalRun } from "./run-context"
import type { EvalQuery } from "./types"

const SEARCH_LIMIT = 10
const MODES: SearchMode[] = ["dense", "hybrid", "rerank"]

const evaluateMode = async (search: Pick<SearchService, "searchTimed">, dataset: EvalQuery[], mode: SearchMode) => {
  const queryResults: EvalQueryResult[] = []
  for (const item of dataset) {
    const result = await search.searchTimed({ query: item.query, limit: SEARCH_LIMIT, mode })
    queryResults.push(
      makeQueryResult(item, result.hits, {
        degraded: result.degraded,
        timingMs: { embed: result.embedMs, qdrant: result.qdrantMs, rerank: result.rerankMs, total: result.totalMs }
      })
    )
  }
  const label =
    mode === "dense"
      ? "dense"
      : mode === "hybrid"
        ? env.rrfSparseWeight === 0
          ? "dense (sparse disabled)"
          : `dense+sparse-${env.sparseWeighting}+idf (RRF)`
        : env.rrfSparseWeight === 0
          ? "dense+reranker"
          : `dense+sparse-${env.sparseWeighting}+idf (RRF)+reranker`
  return { mode, label, ...summarizeQueries(queryResults), queryResults }
}

const run = async (): Promise<void> => {
  const context = await createEvalRun("modes", {
    searchLimit: SEARCH_LIMIT,
    modes: MODES,
    denseRetrievalDepth: SEARCH_LIMIT,
    fusedCandidateDepthPerChannel: Math.min(50, env.rerankCandidates, SEARCH_LIMIT * 5)
  })
  const collection = context.collection()
  await verifyQdrantConnection()
  const qdrant = getQdrantClient()
  await context.captureQdrant(qdrant)
  const vectors = new VectorService(qdrant, collection)
  const search = new SearchService(qdrant, collection)
  console.log(`Indexing ${context.corpus.length} eval documents into ${collection}`)
  await indexCorpus(context.corpus, vectors, collection)

  const byMode = new Map<SearchMode, Awaited<ReturnType<typeof evaluateMode>>>()
  for (const mode of MODES) {
    console.log(`Evaluating mode=${mode}`)
    byMode.set(mode, await evaluateMode(search, context.dataset, mode))
  }
  const baseline = byMode.get("dense")
  if (!baseline) throw new Error("Missing dense baseline")
  const variants = [...byMode.values()].map(variant => ({
    ...variant,
    comparisonToDense: compareQueries(baseline.queryResults, variant.queryResults, context.bootstrapOptions)
  }))
  const valid = variants.every(variant => variant.degradedQueries === 0)
  const path = await context.writeResults({
    collection,
    collectionInfo: await vectors.getCollection(collection),
    documents: context.corpus.length,
    queries: context.dataset.length,
    validForQualityComparison: valid,
    warning: valid
      ? null
      : "Fallbacks occurred. Inspect degraded queries and rerun before drawing quality conclusions.",
    baseline: "dense",
    variants
  })
  console.log(
    JSON.stringify(
      variants.map(({ mode, label, metrics, degradedQueries }) => ({ mode, label, metrics, degradedQueries })),
      null,
      2
    )
  )
  console.log(`Wrote ${path}`)
  if (!valid) throw new Error("Evaluation contains degraded searches; artifact saved but quality comparison is invalid")
}

if (import.meta.main)
  run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })

export { evaluateMode }
