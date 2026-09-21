import type { Context } from "hono"
import { env } from "../../config/env"
import { getQdrantClient } from "../../db/qdrant.client"
import { verifyRedisConnection } from "../../db/redis.client"
import { notReadyError } from "../errors"

const health = async (c: Context) => c.json({ status: "ok" })

const ready = async (c: Context) => {
  const checks = { qdrant: false, redis: false, collection: env.collectionName }

  try {
    await getQdrantClient().getCollection(env.collectionName)
    checks.qdrant = true
  } catch {
    throw notReadyError("Qdrant collection is not reachable")
  }

  try {
    await verifyRedisConnection()
    checks.redis = true
  } catch {
    throw notReadyError("Redis is not reachable")
  }

  return c.json({ status: "ok", ...checks })
}

export { health, ready }
