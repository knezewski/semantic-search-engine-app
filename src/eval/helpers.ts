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

/** Build an isolated evaluation collection; never reuse or delete an existing index. */
const indexCorpus = async (documents: EvalDocument[], vectors: VectorService, collection: string): Promise<void> => {
  const embeddings = getEmbeddingService()
  const created = await vectors.ensureCollection(collection)
  if (!created.created) throw new Error(`Refusing to reuse evaluation collection ${collection}`)

  for (const item of documents) {
    const record = createDocumentRecord({
      id: item.id,
      title: item.title,
      text: item.text,
      source: item.source
    })
    const chunks = await splitDocument(record)
    const chunkVectors = await embeddings.embedBatch(chunks.map(chunk => chunk.text))
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
  mrrAt10: round(metrics.mrrAt10),
  ndcgAt10: round(metrics.ndcgAt10)
})

export { indexCorpus, payloadString, qualitySummary, round }
