/**
 * Single place for process environment.
 * OS env vars stay SCREAMING_SNAKE; this object is camelCase.
 */

const optional = (key: string): string | undefined => {
  const value = process.env[key]
  return value && value.length > 0 ? value : undefined
}

const flag = (key: string, fallback: boolean): boolean => {
  const raw = optional(key)
  if (raw === undefined) return fallback
  return ["1", "true", "yes"].includes(raw.toLowerCase())
}

const integer = (key: string, fallback: number): number => {
  const raw = optional(key)
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be an integer, got "${raw}"`)
  }
  return parsed
}

const env = {
  nodeEnv: optional("NODE_ENV") ?? "development",
  port: integer("PORT", 3000),
  logLevel: optional("LOG_LEVEL") ?? "info",

  redisUrl: optional("REDIS_URL") ?? "redis://localhost:6379",

  sqlitePath: optional("SQLITE_PATH") ?? "./data/semantic-search.sqlite",

  qdrantUrl: optional("QDRANT_URL") ?? "http://localhost:6333",
  qdrantApiKey: optional("QDRANT_API_KEY"),

  collectionName: optional("COLLECTION_NAME") ?? "document_chunks",
  vectorSize: integer("VECTOR_SIZE", 384),
  embeddingModel: optional("EMBEDDING_MODEL") ?? "BAAI/bge-small-en-v1.5",

  chunkSize: integer("CHUNK_SIZE", 500),
  chunkOverlap: integer("CHUNK_OVERLAP", 50),

  searchHnswEf: integer("SEARCH_HNSW_EF", 64),
  embeddingCacheSize: integer("EMBEDDING_CACHE_SIZE", 256),

  rerankEnabled: flag("RERANK_ENABLED", true),
  rerankModel: optional("RERANK_MODEL") ?? "Xenova/ms-marco-MiniLM-L-6-v2",
  rerankCandidates: integer("RERANK_CANDIDATES", 20)
} as const

type AppEnv = typeof env

export type { AppEnv }
export { env }
