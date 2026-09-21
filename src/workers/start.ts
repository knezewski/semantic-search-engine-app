import { env } from "../config/env"
import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { verifyRedisConnection } from "../db/redis.client"
import { getEmbeddingService, warmupEmbeddings } from "../services/embedding"
import { VectorService } from "../services/vector"
import { startChunkWorker } from "./chunk.worker"
import { startEmbeddingWorker } from "./embedding.worker"
import { startIndexWorker } from "./index.worker"
import { startIngestWorker } from "./ingest.worker"

const start = async (): Promise<void> => {
  await verifyRedisConnection()
  await verifyQdrantConnection()
  await new VectorService(getQdrantClient()).ensureCollection()
  await warmupEmbeddings()

  const embeddings = getEmbeddingService()
  const workers = [startIngestWorker(), startChunkWorker(), startEmbeddingWorker(), startIndexWorker()]
  console.log(
    `Workers started: ${workers.map(worker => worker.name).join(", ")} | model=${embeddings.modelId} dims=${embeddings.dimensions} (env=${env.embeddingModel})`
  )

  const shutdown = async (): Promise<void> => {
    await Promise.all(workers.map(worker => worker.close()))
    process.exit(0)
  }

  process.on("SIGINT", () => {
    void shutdown()
  })
  process.on("SIGTERM", () => {
    void shutdown()
  })
}

start().catch(error => {
  console.error("Failed to start workers", error)
  process.exit(1)
})
