import { Worker } from "bullmq"
import { documentStore } from "../db/document.store"
import { getQdrantClient } from "../db/qdrant.client"
import { createQueueConnection } from "../queue/connection"
import { type DocumentJob, QUEUE_NAMES } from "../queue/jobs"
import { VectorService } from "../services/vector"
import { markFailedIfExhausted } from "./on-failed"

const startIndexWorker = (): Worker<DocumentJob> => {
  const vectors = new VectorService(getQdrantClient())

  const worker = new Worker<DocumentJob>(
    QUEUE_NAMES.index,
    async job => {
      const documentId = job.data.documentId
      await documentStore.require(documentId)
      await documentStore.updateStatus(documentId, "indexing")

      const embedded = await documentStore.getEmbeddings(documentId)
      if (embedded.length === 0) {
        throw new Error(`Document ${documentId} has no embeddings to index`)
      }

      await vectors.deleteByDocumentId(documentId)
      await vectors.upsertChunks(embedded)
      await documentStore.updateStatus(documentId, "ready")
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

export { startIndexWorker }
