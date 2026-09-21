const RRF_K = 60

interface Ranked<T> {
  id: string
  item: T
}

const rrfFuse = <T>(lists: Ranked<T>[][], limit: number): T[] => {
  const scores = new Map<string, { score: number; item: T }>()

  for (const list of lists) {
    list.forEach((entry, rank) => {
      const contribution = 1 / (RRF_K + rank + 1)
      const current = scores.get(entry.id)
      if (current) {
        current.score += contribution
      } else {
        scores.set(entry.id, { score: contribution, item: entry.item })
      }
    })
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.item)
}

export type { Ranked }
export { RRF_K, rrfFuse }
