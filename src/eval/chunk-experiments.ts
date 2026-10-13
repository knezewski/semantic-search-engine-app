import { join } from "node:path"
import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { splitDocument } from "../domain/chunk"
import { createDocumentRecord } from "../domain/document"
import { getEmbeddingService } from "../services/embedding"
import { SearchService } from "../services/search"
import { VectorService } from "../services/vector"
import { aggregate, scoreQuery } from "./metrics"
import type { EvalDocument, EvalQuery } from "./types"
import { EVAL_FIXTURE_SET, loadJson } from "./fixtures"
import { round } from "./helpers"

const VARIANTS = [
  { chunkSize: 250, chunkOverlap: 25 },
  { chunkSize: 500, chunkOverlap: 50 },
  { chunkSize: 800, chunkOverlap: 80 }
] as const

const SEARCH_LIMIT = 10

const runVariant = async (corpus: EvalDocument[], dataset: EvalQuery[], chunkSize: number, chunkOverlap: number) => {
  const collection = `document_chunks_eval${EVAL_FIXTURE_SET ? `_${EVAL_FIXTURE_SET}` : ""}_${chunkSize}`
  const qdrant = getQdrantClient()
  const vectors = new VectorService(qdrant, collection)
  const search = new SearchService(qdrant, collection)
  const embeddings = getEmbeddingService()

  await vectors.ensureCollection(collection)

  let chunkCount = 0
  for (const item of corpus) {
    const record = createDocumentRecord({
      id: item.id,
      title: item.title,
      text: item.text,
      source: item.source
    })
    const chunks = await splitDocument(record, { chunkSize, chunkOverlap })
    chunkCount += chunks.length
    const chunkVectors = await embeddings.embedBatch(chunks.map(chunk => chunk.text))
    await vectors.deleteByDocumentId(item.id, collection)
    await vectors.upsertChunks(
      chunks.map((chunk, index) => ({ ...chunk, vector: chunkVectors[index] ?? [] })),
      collection
    )
  }

  const scores = []
  for (const item of dataset) {
    const hits = await search.search({ query: item.query, limit: SEARCH_LIMIT, mode: "dense" })
    scores.push(
      scoreQuery(
        hits.map(hit => hit.documentId),
        item.relevantDocumentIds
      )
    )
  }

  const summary = aggregate(scores)
  return {
    chunkSize,
    chunkOverlap,
    collection,
    chunks: chunkCount,
    chunksPerDocument: Number((chunkCount / corpus.length).toFixed(2)),
    metrics: {
      hitAt5: round(summary.hitAt5),
      recallAt5: round(summary.recallAt5),
      mrr: round(summary.mrr),
      ndcgAt10: round(summary.ndcgAt10)
    }
  }
}

const run = async (): Promise<void> => {
  await verifyQdrantConnection()
  const corpus = await loadJson<EvalDocument[]>("corpus.json")
  const dataset = await loadJson<EvalQuery[]>("dataset.json")

  const variants = []
  for (const variant of VARIANTS) {
    console.log(`Chunk experiment ${variant.chunkSize}/${variant.chunkOverlap}`)
    variants.push(await runVariant(corpus, dataset, variant.chunkSize, variant.chunkOverlap))
  }

  const results = {
    model: getEmbeddingService().modelId,
    documents: corpus.length,
    queries: dataset.length,
    mode: "dense",
    variants
  }

  const outPath = join(import.meta.dir, "../../eval-chunk-results.json")
  await Bun.write(outPath, `${JSON.stringify(results, null, 2)}\n`)
  console.log(JSON.stringify(results, null, 2))
  console.log(`Wrote ${outPath}`)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
