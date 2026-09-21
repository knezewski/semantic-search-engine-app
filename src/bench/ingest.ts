import { join } from "node:path"
import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { splitDocument } from "../domain/chunk"
import { createDocumentRecord } from "../domain/document"
import type { EvalDocument } from "../eval/types"
import { getEmbeddingService, warmupEmbeddings } from "../services/embedding"
import { VectorService } from "../services/vector"

const COLLECTION = "document_chunks_bench"

const perSecond = (count: number, ms: number): number => (ms === 0 ? 0 : Number(((count / ms) * 1000).toFixed(2)))

const run = async (): Promise<void> => {
  await verifyQdrantConnection()
  await warmupEmbeddings()

  const corpus = (await Bun.file(join(import.meta.dir, "../eval/fixtures/corpus.json")).json()) as EvalDocument[]
  const vectors = new VectorService(getQdrantClient(), COLLECTION)
  await vectors.ensureCollection(COLLECTION)

  const records = corpus.map(item =>
    createDocumentRecord({
      id: item.id,
      title: item.title,
      text: item.text,
      source: item.source
    })
  )

  const chunkStarted = performance.now()
  const chunked = []
  for (const record of records) {
    chunked.push(await splitDocument(record))
  }
  const chunkMs = performance.now() - chunkStarted
  const chunks = chunked.flat()

  const embedStarted = performance.now()
  const embeddings = getEmbeddingService()
  const chunkVectors = await embeddings.embedBatch(chunks.map(chunk => chunk.text))
  const embedMs = performance.now() - embedStarted

  const indexStarted = performance.now()
  for (const item of corpus) {
    await vectors.deleteByDocumentId(item.id, COLLECTION)
  }
  await vectors.upsertChunks(
    chunks.map((chunk, index) => ({ ...chunk, vector: chunkVectors[index] ?? [] })),
    COLLECTION
  )
  const indexMs = performance.now() - indexStarted

  const results = {
    documents: records.length,
    chunks: chunks.length,
    timingsMs: {
      chunk: Number(chunkMs.toFixed(2)),
      embed: Number(embedMs.toFixed(2)),
      index: Number(indexMs.toFixed(2))
    },
    throughput: {
      documentsPerSec: perSecond(records.length, chunkMs + embedMs + indexMs),
      chunksPerSec: perSecond(chunks.length, chunkMs),
      embeddingsPerSec: perSecond(chunks.length, embedMs),
      vectorsPerSec: perSecond(chunks.length, indexMs)
    }
  }

  const outPath = join(import.meta.dir, "../../bench-ingest-results.json")
  await Bun.write(outPath, `${JSON.stringify(results, null, 2)}\n`)
  console.log(JSON.stringify(results, null, 2))
  console.log(`Wrote ${outPath}`)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
