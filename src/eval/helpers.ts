import { splitDocument } from "../domain/chunk"
import { createDocumentRecord } from "../domain/document"
import { getEmbeddingService } from "../services/embedding"
import type { VectorService } from "../services/vector"
import type { aggregate } from "./metrics"
import type { EvalDocument } from "./types"

/** Round to 4 decimal places for compact, readable JSON output. */
const round = (value: number): number => Number(value.toFixed(4))

/** Read a string payload field, defaulting to "" for missing/non-string values. */
const payloadString = (payload: unknown, key: string): string => {
  if (typeof payload !== "object" || payload === null) return ""
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === "string" ? value : ""
}

/** Re-embed + re-index the corpus into `collection`, idempotent per document. */
const indexCorpus = async (documents: EvalDocument[], vectors: VectorService, collection: string): Promise<void> => {
  const embeddings = getEmbeddingService()
  await vectors.ensureCollection(collection)

  for (const item of documents) {
    const record = createDocumentRecord({
      id: item.id,
      title: item.title,
      text: item.text,
      source: item.source
    })
    const chunks = await splitDocument(record)
    const chunkVectors = await embeddings.embedBatch(chunks.map(chunk => chunk.text))
    await vectors.deleteByDocumentId(item.id, collection)
    await vectors.upsertChunks(
      chunks.map((chunk, index) => ({ ...chunk, vector: chunkVectors[index] ?? [] })),
      collection
    )
  }
}

/** 4-metric quality summary shared by the sweeps. */
const qualitySummary = (metrics: ReturnType<typeof aggregate>) => ({
  recallAt5: round(metrics.recallAt5),
  recallAt10: round(metrics.recallAt10),
  mrr: round(metrics.mrr),
  ndcgAt10: round(metrics.ndcgAt10)
})

export { indexCorpus, payloadString, qualitySummary, round }
