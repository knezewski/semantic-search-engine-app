import { Worker } from "bullmq"
import { documentStore } from "../db/document.store"
import { splitDocument } from "../domain/chunk"
import { createQueueConnection } from "../queue/connection"
import { type DocumentJob, QUEUE_NAMES } from "../queue/jobs"
import { enqueueEmbedding } from "../queue/queues"
import { markFailedIfExhausted } from "./on-failed"

const startChunkWorker = (): Worker<DocumentJob> => {
  const worker = new Worker<DocumentJob>(
    QUEUE_NAMES.chunk,
    async job => {
      const document = await documentStore.require(job.data.documentId)
      await documentStore.updateStatus(document.id, "chunking")
      const chunks = await splitDocument(document)
      if (chunks.length === 0) {
        throw new Error(`Document ${document.id} produced no chunks`)
      }
      await documentStore.saveChunks(document.id, chunks)
      await enqueueEmbedding(document.id)
    },
    {
      connection: createQueueConnection(),
      prefix: "sse",
      concurrency: 5
    }
  )

  worker.on("failed", (job, error) => {
    void markFailedIfExhausted(job, error)
  })

  return worker
}

export { startChunkWorker }
