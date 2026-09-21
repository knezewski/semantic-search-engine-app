import { QdrantClient } from "@qdrant/js-client-rest"
import { env } from "../config/env"

let instance: QdrantClient | null = null

const getQdrantClient = (): QdrantClient => {
  if (!instance) {
    instance = new QdrantClient({
      url: env.qdrantUrl,
      apiKey: env.qdrantApiKey
    })
  }
  return instance
}

const verifyQdrantConnection = async (): Promise<void> => {
  const qdrantClient = getQdrantClient()
  try {
    const info = await qdrantClient.getCollections()
    console.log(`Qdrant connected — ${info.collections.length} collection(s)`)
  } catch (err) {
    console.error("Qdrant connection failed:", err)
    process.exit(1)
  }
}

export { getQdrantClient, verifyQdrantConnection }
