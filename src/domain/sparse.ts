interface SparseVector {
  indices: number[]
  values: number[]
}

const TOKEN = /[a-z0-9а-яё]{2,}/gi

const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(TOKEN) ?? []).map(token => token.replace(/ё/g, "е"))

/**
 * Stable FNV-1a 32-bit hash. Qdrant sparse indices must be unique unsigned ints.
 */
const termIndex = (term: string): number => {
  let hash = 2166136261
  for (let i = 0; i < term.length; i += 1) {
    hash ^= term.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const toSparseVector = (text: string): SparseVector => {
  const tf = new Map<number, number>()
  for (const token of tokenize(text)) {
    const index = termIndex(token)
    tf.set(index, (tf.get(index) ?? 0) + 1)
  }

  const indices = [...tf.keys()].sort((a, b) => a - b)
  return {
    indices,
    values: indices.map(index => tf.get(index) ?? 0)
  }
}

export type { SparseVector }
export { termIndex, tokenize, toSparseVector }
