import { type JobsOptions, Queue } from "bullmq"
import { createQueueConnection } from "./connection"
import { type DocumentJob, QUEUE_NAMES } from "./jobs"

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 1000
  },
  removeOnComplete: 1000,
  removeOnFail: false
}

const connection = createQueueConnection()

const ingestQueue = new Queue<DocumentJob>(QUEUE_NAMES.ingest, { connection, prefix: "sse" })
const chunkQueue = new Queue<DocumentJob>(QUEUE_NAMES.chunk, { connection, prefix: "sse" })
const embeddingQueue = new Queue<DocumentJob>(QUEUE_NAMES.embedding, { connection, prefix: "sse" })
const indexQueue = new Queue<DocumentJob>(QUEUE_NAMES.index, { connection, prefix: "sse" })

const enqueueIngest = async (documentId: string): Promise<void> => {
  await ingestQueue.add(
    "ingest",
    { documentId },
    {
      ...defaultJobOptions,
      jobId: `ingest:${documentId}`
    }
  )
}

const enqueueChunk = async (documentId: string): Promise<void> => {
  await chunkQueue.add("chunk", { documentId }, { ...defaultJobOptions, jobId: `chunk:${documentId}` })
}

const enqueueEmbedding = async (documentId: string): Promise<void> => {
  await embeddingQueue.add("embed", { documentId }, { ...defaultJobOptions, jobId: `embed:${documentId}` })
}

const enqueueIndex = async (documentId: string): Promise<void> => {
  await indexQueue.add("index", { documentId }, { ...defaultJobOptions, jobId: `index:${documentId}` })
}

const clearPipelineJobs = async (documentId: string): Promise<void> => {
  await Promise.all([
    ingestQueue.remove(`ingest:${documentId}`),
    chunkQueue.remove(`chunk:${documentId}`),
    embeddingQueue.remove(`embed:${documentId}`),
    indexQueue.remove(`index:${documentId}`)
  ])
}

export {
  chunkQueue,
  clearPipelineJobs,
  defaultJobOptions,
  embeddingQueue,
  enqueueChunk,
  enqueueEmbedding,
  enqueueIndex,
  enqueueIngest,
  indexQueue,
  ingestQueue
}
