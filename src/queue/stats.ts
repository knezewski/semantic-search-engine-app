import type { Queue } from "bullmq"
import { QUEUE_NAMES } from "./jobs"
import { chunkQueue, embeddingQueue, indexQueue, ingestQueue } from "./queues"

interface QueueCounts {
  name: string
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
  paused: number
}

const readCounts = async (name: string, queue: Queue): Promise<QueueCounts> => {
  const counts = await queue.getJobCounts("wait", "active", "completed", "failed", "delayed", "paused")
  return {
    name,
    waiting: counts.wait ?? counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
    paused: counts.paused ?? 0
  }
}

const getQueueStats = async (): Promise<{ queues: QueueCounts[] }> => {
  const queues = await Promise.all([
    readCounts(QUEUE_NAMES.ingest, ingestQueue),
    readCounts(QUEUE_NAMES.chunk, chunkQueue),
    readCounts(QUEUE_NAMES.embedding, embeddingQueue),
    readCounts(QUEUE_NAMES.index, indexQueue)
  ])
  return { queues }
}

export type { QueueCounts }
export { getQueueStats }
