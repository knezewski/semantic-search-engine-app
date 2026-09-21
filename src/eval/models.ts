import { join } from "node:path"
import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { splitDocument } from "../domain/chunk"
import { createDocumentRecord } from "../domain/document"
import { HuggingFaceTokenizer } from "../domain/tokenizer"
import { HuggingFaceEmbeddingService } from "../services/embedding"
import { VectorService } from "../services/vector"
import { aggregate, scoreQuery } from "./metrics"
import type { EvalDocument, EvalQuery } from "./types"

const MODELS = [
  { id: "BAAI/bge-small-en-v1.5", dimensions: 384 },
  { id: "Xenova/all-MiniLM-L6-v2", dimensions: 384 }
] as const

const SEARCH_LIMIT = 10

const slug = (modelId: string): string => modelId.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40)

const loadJson = async <T>(name: string): Promise<T> =>
  (await Bun.file(join(import.meta.dir, "fixtures", name)).json()) as T

const evaluateModel = async (corpus: EvalDocument[], dataset: EvalQuery[], modelId: string, dimensions: number) => {
  const collection = `eval_model_${slug(modelId)}`
  const embeddings = new HuggingFaceEmbeddingService(modelId, dimensions)
  const tokenizer = new HuggingFaceTokenizer(modelId)
  const vectors = new VectorService(getQdrantClient(), collection)

  await vectors.ensureCollection(collection, { vectorSize: dimensions })

  const embedStarted = performance.now()
  for (const item of corpus) {
    const record = createDocumentRecord({
      id: item.id,
      title: item.title,
      text: item.text,
      source: item.source
    })
    const chunks = await splitDocument(record, { tokenizer })
    const chunkVectors = await embeddings.embedBatch(chunks.map(chunk => chunk.text))
    await vectors.deleteByDocumentId(item.id, collection)
    await vectors.upsertChunks(
      chunks.map((chunk, index) => ({ ...chunk, vector: chunkVectors[index] ?? [] })),
      collection
    )
  }
  const indexMs = performance.now() - embedStarted

  const queryStarted = performance.now()
  const scores = []
  for (const item of dataset) {
    const queryVector = await embeddings.embed(item.query)
    const hits = await vectors.searchChunks({ vector: queryVector, limit: SEARCH_LIMIT })
    scores.push(
      scoreQuery(
        hits.map(hit => {
          const payload = (hit.payload ?? {}) as Record<string, unknown>
          return typeof payload.documentId === "string" ? payload.documentId : ""
        }),
        item.relevantDocumentIds
      )
    )
  }
  const queryMs = performance.now() - queryStarted
  const summary = aggregate(scores)
  const round = (value: number) => Number(value.toFixed(4))

  return {
    modelId,
    dimensions,
    collection,
    indexMs: Number(indexMs.toFixed(1)),
    queryMs: Number(queryMs.toFixed(1)),
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

  const models = []
  for (const model of MODELS) {
    console.log(`Evaluating embedding model ${model.id}`)
    models.push(await evaluateModel(corpus, dataset, model.id, model.dimensions))
  }

  const results = { documents: corpus.length, queries: dataset.length, mode: "dense", models }
  const outPath = join(import.meta.dir, "../../eval-model-results.json")
  await Bun.write(outPath, `${JSON.stringify(results, null, 2)}\n`)
  console.log(JSON.stringify(results, null, 2))
  console.log(`Wrote ${outPath}`)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
