import { Worker } from "bullmq"
import { documentStore } from "../db/document.store"
import type { EmbeddedChunk } from "../domain/embedding"
import { createQueueConnection } from "../queue/connection"
import { type DocumentJob, QUEUE_NAMES } from "../queue/jobs"
import { enqueueIndex } from "../queue/queues"
import { getEmbeddingService } from "../services/embedding"
import { markFailedIfExhausted } from "./on-failed"

const EMBED_BATCH_SIZE = 32

const startEmbeddingWorker = (): Worker<DocumentJob> => {
  const worker = new Worker<DocumentJob>(
    QUEUE_NAMES.embedding,
    async job => {
      const documentId = job.data.documentId
      await documentStore.require(documentId)
      await documentStore.updateStatus(documentId, "embedding")

      const chunks = await documentStore.getChunks(documentId)
      if (chunks.length === 0) {
        throw new Error(`Document ${documentId} has no chunks to embed`)
      }

      const embedded: EmbeddedChunk[] = []
      for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBED_BATCH_SIZE)
        const embeddings = await getEmbeddingService().embedBatch(batch.map(chunk => chunk.text))
        batch.forEach((chunk, index) => {
          const vector = embeddings[index]
          if (!vector || vector.length === 0) {
            throw new Error(`Missing embedding for chunk ${chunk.chunkId}`)
          }
          embedded.push({ ...chunk, vector })
        })
      }

      await documentStore.saveEmbeddings(documentId, embedded)
      await enqueueIndex(documentId)
    },
    {
      connection: createQueueConnection(),
      prefix: "sse",
      concurrency: 1
    }
  )

  worker.on("failed", (job, error) => {
    void markFailedIfExhausted(job, error)
  })

  return worker
}

export { startEmbeddingWorker }
