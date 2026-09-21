import type { ConnectionOptions } from "bullmq"
import { env } from "../config/env"

/**
 * BullMQ needs maxRetriesPerRequest: null.
 * Returning options (not a shared ioredis instance) lets each queue/worker
 * own its connection, which is what BullMQ expects.
 */
const createQueueConnection = (): ConnectionOptions => ({
  url: env.redisUrl,
  maxRetriesPerRequest: null,
  enableReadyCheck: true
})

export { createQueueConnection }
