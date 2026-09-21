const unique = (values: string[]): string[] => [...new Set(values)]

const hitAtK = (retrieved: string[], relevant: string[], k: number): number => {
  const gold = new Set(relevant)
  if (gold.size === 0) return 0
  return retrieved.slice(0, k).some(id => gold.has(id)) ? 1 : 0
}

const recallAtK = (retrieved: string[], relevant: string[], k: number): number => {
  const gold = unique(relevant)
  if (gold.length === 0) return 0
  const top = new Set(retrieved.slice(0, k))
  const hits = gold.filter(id => top.has(id)).length
  return hits / gold.length
}

const reciprocalRank = (retrieved: string[], relevant: string[]): number => {
  const gold = new Set(relevant)
  if (gold.size === 0) return 0
  const rank = retrieved.findIndex(id => gold.has(id))
  return rank === -1 ? 0 : 1 / (rank + 1)
}

const ndcgAtK = (retrieved: string[], relevant: string[], k: number): number => {
  const gold = new Set(relevant)
  if (gold.size === 0) return 0

  const dcg = retrieved.slice(0, k).reduce((sum, id, index) => {
    const gain = gold.has(id) ? 1 : 0
    return sum + gain / Math.log2(index + 2)
  }, 0)

  const idealHits = Math.min(gold.size, k)
  const idcg = Array.from({ length: idealHits }, (_, index) => 1 / Math.log2(index + 2)).reduce(
    (sum, value) => sum + value,
    0
  )

  return idcg === 0 ? 0 : dcg / idcg
}

interface QueryScore {
  hitAt5: number
  hitAt10: number
  recallAt5: number
  recallAt10: number
  mrr: number
  ndcgAt10: number
}

const scoreQuery = (retrieved: string[], relevant: string[]): QueryScore => ({
  hitAt5: hitAtK(retrieved, relevant, 5),
  hitAt10: hitAtK(retrieved, relevant, 10),
  recallAt5: recallAtK(retrieved, relevant, 5),
  recallAt10: recallAtK(retrieved, relevant, 10),
  mrr: reciprocalRank(retrieved, relevant),
  ndcgAt10: ndcgAtK(retrieved, relevant, 10)
})

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

const aggregate = (scores: QueryScore[]): QueryScore => ({
  hitAt5: mean(scores.map(score => score.hitAt5)),
  hitAt10: mean(scores.map(score => score.hitAt10)),
  recallAt5: mean(scores.map(score => score.recallAt5)),
  recallAt10: mean(scores.map(score => score.recallAt10)),
  mrr: mean(scores.map(score => score.mrr)),
  ndcgAt10: mean(scores.map(score => score.ndcgAt10))
})

export type { QueryScore }
export { aggregate, hitAtK, ndcgAtK, recallAtK, reciprocalRank, scoreQuery }
