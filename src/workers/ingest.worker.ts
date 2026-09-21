import { Worker } from "bullmq"
import { documentStore } from "../db/document.store"
import { createQueueConnection } from "../queue/connection"
import { type DocumentJob, QUEUE_NAMES } from "../queue/jobs"
import { enqueueChunk } from "../queue/queues"
import { markFailedIfExhausted } from "./on-failed"

const startIngestWorker = (): Worker<DocumentJob> => {
  const worker = new Worker<DocumentJob>(
    QUEUE_NAMES.ingest,
    async job => {
      const document = await documentStore.require(job.data.documentId)
      if (!document.text.trim()) {
        throw new Error(`Document ${document.id} has empty text`)
      }
      await enqueueChunk(document.id)
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

export { startIngestWorker }
