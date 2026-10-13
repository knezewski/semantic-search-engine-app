const RRF_K = 60

interface Ranked<T> {
  id: string
  item: T
}

interface RrfOptions {
  /** Reciprocal-rank constant. Larger `k` softens the difference between adjacent ranks. */
  k?: number
  /** Per-channel weights, aligned with `lists`. Defaults to `1` for every channel. */
  weights?: number[]
}

const rrfFuse = <T>(lists: Ranked<T>[][], limit: number, options: RrfOptions = {}): T[] => {
  const k = options.k ?? RRF_K
  const weights = options.weights ?? lists.map(() => 1)
  const scores = new Map<string, { score: number; item: T }>()

  lists.forEach((list, listIndex) => {
    const weight = weights[listIndex] ?? 1
    if (weight === 0) return
    list.forEach((entry, rank) => {
      const contribution = weight / (k + rank + 1)
      const current = scores.get(entry.id)
      if (current) {
        current.score += contribution
      } else {
        scores.set(entry.id, { score: contribution, item: entry.item })
      }
    })
  })

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.item)
}

export type { Ranked, RrfOptions }
export { RRF_K, rrfFuse }
