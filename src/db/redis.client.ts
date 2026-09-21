import Redis from "ioredis"
import { env } from "../config/env"

let instance: Redis | null = null

const getRedis = (): Redis => {
  if (!instance) {
    instance = new Redis(env.redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true
    })
  }
  return instance
}

const verifyRedisConnection = async (): Promise<void> => {
  const pong = await getRedis().ping()
  if (pong !== "PONG") {
    throw new Error(`Redis ping failed: ${pong}`)
  }
}

const closeRedis = async (): Promise<void> => {
  if (!instance) return
  await instance.quit()
  instance = null
}

export { closeRedis, getRedis, verifyRedisConnection }
