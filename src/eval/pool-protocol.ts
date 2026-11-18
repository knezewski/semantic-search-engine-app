import { createHash } from "node:crypto"
import { makeQueryResult } from "./report"
import type { EvalQuery } from "./types"

export type PoolProtocol = "fixed-candidates" | "serving-depth"
export interface PoolCandidate {
  documentId: string
  chunkId: string
  text: string
  score: number
}
export interface PoolPorts {
  embed(query: string): Promise<number[]>
  search(vector: number[], limit: number): Promise<PoolCandidate[]>
  score(query: string, passages: string[]): Promise<number[]>
}
export const parsePoolProtocol = (value = "fixed-candidates"): PoolProtocol => {
  if (value !== "fixed-candidates" && value !== "serving-depth")
    throw new Error(
      `Invalid EVAL_POOL_PROTOCOL: ${value}; expected fixed-candidates or serving-depth (legacy reuse removed)`
    )
  return value
}
export const validateCandidates = (candidates: PoolCandidate[], limit: number): void => {
  if (candidates.length > limit || new Set(candidates.map(candidate => candidate.chunkId)).size !== candidates.length)
    throw new Error("Invalid candidate count or duplicate chunk IDs")
  for (const candidate of candidates)
    if (
      !candidate.chunkId?.trim() ||
      !candidate.documentId?.trim() ||
      typeof candidate.text !== "string" ||
      !candidate.text.trim() ||
      !Number.isFinite(candidate.score)
    )
      throw new Error("Invalid candidate IDs, passage or dense score")
}
export const candidateEvidence = (candidates: PoolCandidate[], scores?: number[]) =>
  candidates.map((candidate, index) => ({
    chunkId: candidate.chunkId,
    documentId: candidate.documentId,
    denseRank: index + 1,
    denseScore: candidate.score,
    textSha256: createHash("sha256").update(candidate.text).digest("hex"),
    ...(scores ? { rerankScore: scores[index] } : {})
  }))

export const scorePool = async (item: EvalQuery, candidates: PoolCandidate[], ports: PoolPorts, searchLimit = 10) => {
  validateCandidates(candidates, candidates.length)
  const scores = candidates.length
    ? await ports.score(
        item.query,
        candidates.map(candidate => candidate.text)
      )
    : []
  if (scores.length !== candidates.length || scores.some(score => !Number.isFinite(score)))
    throw new Error(`Invalid reranker scores for ${item.id}`)
  const ranked = candidates
    .map((candidate, index) => ({ ...candidate, denseRank: index + 1, score: scores[index] }))
    .sort((a, b) => b.score - a.score || a.denseRank - b.denseRank || a.chunkId.localeCompare(b.chunkId))
  return {
    candidateScores: candidateEvidence(candidates, scores),
    queryResult: makeQueryResult(item, ranked.slice(0, searchLimit))
  }
}

export const preparePoolQuery = async (
  item: EvalQuery,
  ports: PoolPorts,
  protocol: PoolProtocol,
  pools: readonly number[] = [15, 30, 50],
  searchLimit = 10
) => {
  if (
    !pools.length ||
    pools.some(pool => !Number.isSafeInteger(pool) || pool < searchLimit) ||
    new Set(pools).size !== pools.length
  )
    throw new Error("Invalid pools")
  const vector = await ports.embed(item.query)
  const maxPool = Math.max(...pools)
  const baselineCandidates = await ports.search(vector, protocol === "fixed-candidates" ? maxPool : searchLimit)
  validateCandidates(baselineCandidates, protocol === "fixed-candidates" ? maxPool : searchLimit)
  const variants = []
  for (const pool of pools) {
    const candidates =
      protocol === "fixed-candidates" ? baselineCandidates.slice(0, pool) : await ports.search(vector, pool)
    validateCandidates(candidates, pool)
    variants.push({ pool, candidates, ...(await scorePool(item, candidates, ports, searchLimit)) })
  }
  return {
    id: item.id,
    item,
    baseline: makeQueryResult(item, baselineCandidates.slice(0, searchLimit)),
    baselineCandidates: candidateEvidence(baselineCandidates),
    variants
  }
}

/** Timed reproduction of embedding-service -> vector retrieval -> independent scoring, not SearchService. */
export const measurePoolPath = async (
  item: EvalQuery,
  pool: number,
  ports: PoolPorts,
  protocol: PoolProtocol,
  maxPool = 50
) => {
  const started = performance.now()
  const vector = await ports.embed(item.query)
  const embedded = performance.now()
  const depth = protocol === "fixed-candidates" ? maxPool : pool
  const retrieved = await ports.search(vector, depth)
  validateCandidates(retrieved, depth)
  const candidates = retrieved.slice(0, pool)
  const searched = performance.now()
  const scores = candidates.length
    ? await ports.score(
        item.query,
        candidates.map(candidate => candidate.text)
      )
    : []
  if (scores.length !== candidates.length || scores.some(score => !Number.isFinite(score)))
    throw new Error(`Invalid reranker scores for ${item.id}`)
  const ended = performance.now()
  return {
    candidates: candidates.length,
    stagesMs: {
      embed: embedded - started,
      retrieval: searched - embedded,
      rerank: ended - searched,
      endToEnd: ended - started
    }
  }
}
