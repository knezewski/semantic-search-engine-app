import { aggregate, type QueryScore, scoreQuery, uniqueDocumentIds } from "./metrics"
import { compareScores } from "./statistics"
import type { EvalQuery } from "./types"

interface RetrievedHit {
  documentId: string
  chunkId: string
  score?: number
}
interface EvalQueryResult {
  id: string
  query: string
  relevantDocumentIds: string[]
  retrieved: Array<RetrievedHit & { rank: number }>
  documentRanking: string[]
  metrics: QueryScore
  degraded: string[]
  timingMs: Record<string, number>
}

/** Score only the supplied chunk window; do not silently backfill unique documents. */
const makeQueryResult = (
  item: EvalQuery,
  hits: RetrievedHit[],
  details: { degraded?: string[]; timingMs?: Record<string, number> } = {}
): EvalQueryResult => {
  if (hits.some(hit => !hit.documentId?.trim() || !hit.chunkId?.trim())) {
    throw new Error(`Missing document/chunk ID in retrieved results for ${item.id}`)
  }
  if (hits.some(hit => hit.score !== undefined && !Number.isFinite(hit.score))) {
    throw new Error(`Nonfinite retrieval score for ${item.id}`)
  }
  const documentRanking = uniqueDocumentIds(hits.map(hit => hit.documentId))
  return {
    id: item.id,
    query: item.query,
    relevantDocumentIds: uniqueDocumentIds(item.relevantDocumentIds),
    // Pick fields explicitly: never include passage text or arbitrary service payloads.
    retrieved: hits.map((hit, index) => ({
      rank: index + 1,
      documentId: hit.documentId,
      chunkId: hit.chunkId,
      ...(hit.score === undefined ? {} : { score: hit.score })
    })),
    documentRanking,
    metrics: scoreQuery(documentRanking, item.relevantDocumentIds),
    degraded: [...(details.degraded ?? [])],
    timingMs: { ...details.timingMs }
  }
}

const summarizeQueries = (rows: EvalQueryResult[]) => {
  if (!rows.length) throw new Error("Cannot summarize an empty evaluation")
  const slices: Record<string, { n: number; metrics: QueryScore }> = {}
  const groups = new Map<string, EvalQueryResult[]>()
  for (const row of rows) {
    const n = row.relevantDocumentIds.length
    const words = row.query.trim().split(/\s+/).length
    const labels = [
      `gold-count:${n === 0 ? "0" : n === 1 ? "1" : n <= 3 ? "2-3" : "4+"}`,
      `query-words:${words <= 5 ? "1-5" : words <= 9 ? "6-9" : "10+"}`,
      `execution:${row.degraded.length ? "degraded" : "healthy"}`
    ]
    for (const label of labels) {
      const bucket = groups.get(label) ?? []
      bucket.push(row)
      groups.set(label, bucket)
    }
  }
  for (const [label, bucket] of groups)
    slices[label] = { n: bucket.length, metrics: aggregate(bucket.map(row => row.metrics)) }
  return {
    n: rows.length,
    degradedQueries: rows.filter(row => row.degraded.length > 0).length,
    metrics: aggregate(rows.map(row => row.metrics)),
    slices
  }
}

const compareQueries = (
  baseline: EvalQueryResult[],
  variant: EvalQueryResult[],
  options?: Parameters<typeof compareScores>[2]
) => {
  if (
    new Set(baseline.map(row => row.id)).size !== baseline.length ||
    new Set(variant.map(row => row.id)).size !== variant.length ||
    baseline.length !== variant.length ||
    baseline.some((row, index) => row.id !== variant[index].id)
  ) {
    throw new Error("Paired comparisons require identical unique query IDs in identical order")
  }
  return compareScores(
    baseline.map(row => row.metrics),
    variant.map(row => row.metrics),
    options
  )
}

export type { EvalQueryResult, RetrievedHit }
export { compareQueries, makeQueryResult, summarizeQueries }
