import type { QdrantClient } from "@qdrant/js-client-rest"
import { env } from "../../config/env"
import { toSparseVector } from "../../domain/sparse"
import { getEmbeddingService } from "../embedding"
import { getRerankService } from "../rerank"
import { VectorService } from "../vector"
import { rrfFuse } from "./rrf"

type SearchMode = "dense" | "hybrid" | "rerank"

interface SearchQuery {
  query: string
  limit?: number
  source?: string
  scoreThreshold?: number
  mode?: SearchMode
}

interface SearchHit {
  chunkId: string
  documentId: string
  text: string
  score: number
  title: string
  source: string | null
  position: number
}

interface TimedSearchResult {
  hits: SearchHit[]
  embedMs: number
  qdrantMs: number
  rerankMs: number
  totalMs: number
  mode: SearchMode
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

const candidateLimit = (limit: number): number => Math.min(50, Math.max(env.rerankCandidates, limit * 5))

const resolveMode = (mode?: SearchMode): SearchMode => {
  if (mode) return mode
  return env.rerankEnabled ? "rerank" : "hybrid"
}

export class SearchService {
  private vectors: VectorService

  constructor(qdrant: QdrantClient, collection: string = env.collectionName) {
    this.vectors = new VectorService(qdrant, collection)
  }

  async search(input: SearchQuery): Promise<SearchHit[]> {
    const timed = await this.searchTimed(input)
    return timed.hits
  }

  async searchTimed(input: SearchQuery): Promise<TimedSearchResult> {
    const limit = input.limit ?? 5
    const mode = resolveMode(input.mode)
    const started = performance.now()
    const vector = await getEmbeddingService().embed(input.query)
    const embedMs = performance.now() - started

    const qdrantStarted = performance.now()
    const pool = candidateLimit(limit)
    const retrieveLimit = mode === "dense" ? limit : pool

    const densePromise = this.vectors.searchChunks({
      vector,
      limit: retrieveLimit,
      source: input.source,
      scoreThreshold: mode === "dense" ? input.scoreThreshold : undefined
    })

    let hits: SearchHit[]
    if (mode === "dense") {
      hits = (await densePromise).map(point => this.toHit(point))
    } else {
      // Dense and sparse searches are independent — run them in parallel.
      const [densePoints, sparseHits] = await Promise.all([
        densePromise,
        this.sparseHits(input.query, pool, input.source)
      ])
      const denseHits = densePoints.map(point => this.toHit(point))
      hits = rrfFuse(
        [
          denseHits.map(hit => ({ id: hit.chunkId, item: hit })),
          sparseHits.map(hit => ({ id: hit.chunkId, item: hit }))
        ],
        pool
      )
    }

    const qdrantMs = performance.now() - qdrantStarted

    let rerankMs = 0
    if (mode === "rerank") {
      const rerankStarted = performance.now()
      hits = await this.rerankHits(input.query, hits, limit)
      rerankMs = performance.now() - rerankStarted
    } else {
      hits = hits.slice(0, limit)
    }

    return {
      hits,
      embedMs,
      qdrantMs,
      rerankMs,
      totalMs: performance.now() - started,
      mode
    }
  }

  private async sparseHits(query: string, pool: number, source?: string): Promise<SearchHit[]> {
    try {
      const sparsePoints = await this.vectors.searchSparse({
        sparse: toSparseVector(query),
        limit: pool,
        source
      })
      return sparsePoints.map(point => this.toHit(point))
    } catch (error) {
      console.warn("Sparse search unavailable, falling back to dense-only hybrid", error)
      return []
    }
  }

  private async rerankHits(query: string, hits: SearchHit[], limit: number): Promise<SearchHit[]> {
    if (hits.length === 0) return hits
    const scores = await getRerankService().score(
      query,
      hits.map(hit => hit.text)
    )
    return hits
      .map((hit, index) => ({ ...hit, score: scores[index] ?? hit.score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  private toHit(point: { id: string | number; score: number; payload?: Record<string, unknown> | null }): SearchHit {
    const payload = (point.payload ?? {}) as Record<string, unknown>
    return {
      chunkId: asString(payload.chunkId) ?? String(point.id),
      documentId: asString(payload.documentId) ?? "",
      text: asString(payload.text) ?? "",
      score: point.score,
      title: asString(payload.title) ?? "",
      source: asString(payload.source) ?? null,
      position: asNumber(payload.position, 0)
    }
  }
}

export type { SearchHit, SearchMode, SearchQuery, TimedSearchResult }
