const METRICS_VERSION = "document-v2" as const

/** Document IDs in first-occurrence order, without mutating the input. */
const uniqueDocumentIds = (values: readonly string[]): string[] => [...new Set(values)]

const validateK = (k: number): void => {
  if (!Number.isSafeInteger(k) || k < 0) {
    throw new RangeError("k must be a nonnegative safe integer")
  }
}

const hitAtK = (retrieved: readonly string[], relevant: readonly string[], k: number): number => {
  validateK(k)
  const gold = new Set(relevant)
  return uniqueDocumentIds(retrieved)
    .slice(0, k)
    .some(id => gold.has(id))
    ? 1
    : 0
}

const recallAtK = (retrieved: readonly string[], relevant: readonly string[], k: number): number => {
  validateK(k)
  const gold = new Set(relevant)
  if (gold.size === 0) return 0
  const hits = uniqueDocumentIds(retrieved)
    .slice(0, k)
    .filter(id => gold.has(id)).length
  return hits / gold.size
}

/** Reciprocal rank over all unique retrieved documents (no cutoff). */
const reciprocalRank = (retrieved: readonly string[], relevant: readonly string[]): number => {
  const gold = new Set(relevant)
  const rank = uniqueDocumentIds(retrieved).findIndex(id => gold.has(id))
  return rank === -1 ? 0 : 1 / (rank + 1)
}

const ndcgAtK = (retrieved: readonly string[], relevant: readonly string[], k: number): number => {
  validateK(k)
  const gold = new Set(relevant)
  if (gold.size === 0 || k === 0) return 0

  const dcg = uniqueDocumentIds(retrieved)
    .slice(0, k)
    .reduce((sum, id, index) => {
      const gain = gold.has(id) ? 1 : 0
      return sum + gain / Math.log2(index + 2)
    }, 0)

  const idealHits = Math.min(gold.size, k)
  let idcg = 0
  for (let index = 0; index < idealHits; index++) {
    idcg += 1 / Math.log2(index + 2)
  }

  return dcg / idcg
}

interface QueryScore {
  hitAt1: number
  hitAt5: number
  hitAt10: number
  recallAt1: number
  recallAt5: number
  recallAt10: number
  mrrAt10: number
  ndcgAt10: number
}

const scoreQuery = (retrieved: readonly string[], relevant: readonly string[]): QueryScore => {
  const documents = uniqueDocumentIds(retrieved)
  return {
    hitAt1: hitAtK(documents, relevant, 1),
    hitAt5: hitAtK(documents, relevant, 5),
    hitAt10: hitAtK(documents, relevant, 10),
    recallAt1: recallAtK(documents, relevant, 1),
    recallAt5: recallAtK(documents, relevant, 5),
    recallAt10: recallAtK(documents, relevant, 10),
    mrrAt10: reciprocalRank(documents.slice(0, 10), relevant),
    ndcgAt10: ndcgAtK(documents, relevant, 10)
  }
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

const aggregate = (scores: readonly QueryScore[]): QueryScore => ({
  hitAt1: mean(scores.map(score => score.hitAt1)),
  hitAt5: mean(scores.map(score => score.hitAt5)),
  hitAt10: mean(scores.map(score => score.hitAt10)),
  recallAt1: mean(scores.map(score => score.recallAt1)),
  recallAt5: mean(scores.map(score => score.recallAt5)),
  recallAt10: mean(scores.map(score => score.recallAt10)),
  mrrAt10: mean(scores.map(score => score.mrrAt10)),
  ndcgAt10: mean(scores.map(score => score.ndcgAt10))
})

export type { QueryScore }
export { aggregate, hitAtK, METRICS_VERSION, ndcgAtK, recallAtK, reciprocalRank, scoreQuery, uniqueDocumentIds }
