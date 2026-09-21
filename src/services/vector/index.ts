import type { QdrantClient } from "@qdrant/js-client-rest"
import { env } from "../../config/env"
import type { EmbeddedChunk } from "../../domain/embedding"
import { type SparseVector, toSparseVector } from "../../domain/sparse"
import { pointIdForChunk } from "../../utils/hash"

const PAYLOAD_INDEXES = ["documentId", "source"] as const
const SPARSE_NAME = "bm25"

type SearchHits = Awaited<ReturnType<QdrantClient["search"]>>

interface SearchChunksInput {
  vector: number[]
  limit?: number
  source?: string
  scoreThreshold?: number
  hnswEf?: number
}

interface CollectionTune {
  vectorSize?: number
  hnswM?: number
  hnswEfConstruct?: number
  scalarQuantization?: boolean
}

export class VectorService {
  constructor(
    private qdrant: QdrantClient,
    private collectionName: string = env.collectionName
  ) {}

  /**
   * Idempotent bootstrap of the single `document_chunks` collection.
   * Creates missing payload indexes. Refuses to silently reuse a collection
   * with a different vector size.
   */
  async ensureCollection(
    name: string = this.collectionName,
    tune: CollectionTune = {}
  ): Promise<{ created: boolean; name: string }> {
    const vectorSize = tune.vectorSize ?? env.vectorSize
    const collections = await this.qdrant.getCollections()
    const exists = collections.collections.some(collection => collection.name === name)

    if (!exists) {
      await this.qdrant.createCollection(name, {
        vectors: {
          size: vectorSize,
          distance: "Cosine"
        },
        sparse_vectors: {
          [SPARSE_NAME]: {
            modifier: "idf"
          }
        },
        hnsw_config: {
          m: tune.hnswM ?? 16,
          ef_construct: tune.hnswEfConstruct ?? 128
        },
        quantization_config: tune.scalarQuantization
          ? {
              scalar: {
                type: "int8",
                quantile: 0.99,
                always_ram: true
              }
            }
          : undefined,
        optimizers_config: {
          default_segment_number: 2
        }
      } as Parameters<QdrantClient["createCollection"]>[1])
    } else {
      const details = await this.qdrant.getCollection(name)
      const existingSize = VectorService.readVectorSize(details)
      if (existingSize !== undefined && existingSize !== vectorSize) {
        throw new Error(
          `Collection ${name} has vector size ${existingSize}, expected ${vectorSize}. Create a new collection instead of mixing models.`
        )
      }
    }

    await this.ensureSparseVector(name)
    await this.ensurePayloadIndexes(name)
    return { created: !exists, name }
  }

  async createCollection(name: string) {
    return this.ensureCollection(name)
  }

  async getCollection(name: string) {
    return this.qdrant.getCollection(name)
  }

  async getCollections() {
    const res = await this.qdrant.getCollections()
    return res.collections
  }

  async deleteCollection(name: string) {
    return this.qdrant.deleteCollection(name)
  }

  async upsertChunks(chunks: EmbeddedChunk[], collection = this.collectionName): Promise<void> {
    if (chunks.length === 0) return

    await this.qdrant.upsert(collection, {
      wait: true,
      points: chunks.map(chunk => {
        const sparse = toSparseVector(`${chunk.title} ${chunk.text}`)
        return {
          id: pointIdForChunk(chunk.chunkId),
          // Unnamed dense vector is addressed with "" when mixed with named sparse vectors.
          vector: {
            "": chunk.vector,
            [SPARSE_NAME]: {
              indices: sparse.indices,
              values: sparse.values
            }
          },
          payload: {
            documentId: chunk.documentId,
            chunkId: chunk.chunkId,
            text: chunk.text,
            title: chunk.title,
            source: chunk.source ?? "",
            position: chunk.position
          }
        }
      })
    })
  }

  async searchChunks(input: SearchChunksInput, collection = this.collectionName): Promise<SearchHits> {
    return this.qdrant.search(collection, {
      vector: input.vector,
      limit: input.limit ?? 10,
      score_threshold: input.scoreThreshold,
      with_payload: true,
      with_vector: false,
      params: {
        hnsw_ef: input.hnswEf ?? env.searchHnswEf,
        exact: false
      },
      filter: input.source
        ? {
            must: [{ key: "source", match: { value: input.source } }]
          }
        : undefined
    })
  }

  async searchSparse(
    input: {
      sparse: SparseVector
      limit?: number
      source?: string
    },
    collection = this.collectionName
  ): Promise<SearchHits> {
    if (input.sparse.indices.length === 0) return []

    return this.qdrant.search(collection, {
      vector: {
        name: SPARSE_NAME,
        vector: {
          indices: input.sparse.indices,
          values: input.sparse.values
        }
      },
      limit: input.limit ?? 10,
      with_payload: true,
      with_vector: false,
      filter: input.source
        ? {
            must: [{ key: "source", match: { value: input.source } }]
          }
        : undefined
    } as Parameters<QdrantClient["search"]>[1])
  }

  async deleteByDocumentId(documentId: string, collection = this.collectionName): Promise<void> {
    await this.qdrant.delete(collection, {
      wait: true,
      filter: {
        must: [{ key: "documentId", match: { value: documentId } }]
      }
    })
  }

  private async ensureSparseVector(name: string): Promise<void> {
    const details = await this.qdrant.getCollection(name)
    const sparse = details.config?.params?.sparse_vectors
    if (sparse && SPARSE_NAME in sparse) return

    await this.qdrant.updateCollection(name, {
      sparse_vectors: {
        [SPARSE_NAME]: {
          modifier: "idf"
        }
      }
    } as Parameters<QdrantClient["updateCollection"]>[1])
  }

  private async ensurePayloadIndexes(name: string): Promise<void> {
    const details = await this.qdrant.getCollection(name)
    const existing = new Set(Object.keys(details.payload_schema ?? {}))

    for (const field of PAYLOAD_INDEXES) {
      if (existing.has(field)) continue
      await this.qdrant.createPayloadIndex(name, {
        field_name: field,
        field_schema: "keyword",
        wait: true
      })
    }
  }

  private static readVectorSize(details: Awaited<ReturnType<QdrantClient["getCollection"]>>): number | undefined {
    const config = details.config?.params?.vectors
    if (!config || Array.isArray(config)) return undefined
    if (typeof config === "object" && "size" in config && typeof config.size === "number") {
      return config.size
    }
    return undefined
  }
}
