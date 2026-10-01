import { serve } from "bun"
import { Hono } from "hono"
import { logger } from "hono/logger"
import { toErrorBody } from "./api/errors"
import routes from "./api/routes/index"
import { env } from "./config/env"
import { getQdrantClient, verifyQdrantConnection } from "./db/qdrant.client"
import { closeRedis } from "./db/redis.client"
import { closeQueues } from "./queue/queues"
import { warmupEmbeddings } from "./services/embedding"
import { warmupRerank } from "./services/rerank"
import { VectorService } from "./services/vector"

const app = new Hono()

app.use("*", logger())
app.route("/", routes)

app.notFound(c => c.json({ error: { code: "NOT_FOUND", message: `No route for ${c.req.method} ${c.req.path}` } }, 404))

app.onError((error, c) => {
  const mapped = toErrorBody(error)
  console.error(error)
  return c.json(mapped.body, mapped.status as 400 | 404 | 500 | 503)
})

const start = async (): Promise<void> => {
  await verifyQdrantConnection()
  const vectors = new VectorService(getQdrantClient())
  const collection = await vectors.ensureCollection()
  await warmupEmbeddings()
  console.log("Embedding model warmed up")
  if (env.rerankEnabled) {
    await warmupRerank()
    console.log(`Rerank model warmed up (${env.rerankModel})`)
  }
  console.log(
    collection.created ? `Qdrant collection ${collection.name} created` : `Qdrant collection ${collection.name} ready`
  )

  const server = serve({ fetch: app.fetch, port: env.port })
  console.log(`Server running on http://localhost:${env.port}`)

  const shutdown = async (): Promise<void> => {
    console.log("Shutting down API...")
    // Stop accepting new connections and drain in-flight requests.
    await server.stop()
    await closeQueues()
    await closeRedis()
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
  console.error("Failed to start server", error)
  process.exit(1)
})
