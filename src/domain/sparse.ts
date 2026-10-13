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

const BM25_K1 = 1.2
const BM25_B = 0.75

/** `tf`: raw term counts. `bm25`: Okapi TF saturation and length normalisation (Qdrant's idf modifier supplies IDF). */
type SparseWeighting = "tf" | "bm25"

const termCounts = (text: string): { counts: Map<number, number>; length: number } => {
  const counts = new Map<number, number>()
  const tokens = tokenize(text)
  for (const token of tokens) {
    const index = termIndex(token)
    counts.set(index, (counts.get(index) ?? 0) + 1)
  }
  return { counts, length: tokens.length }
}

const toSparseVector = (text: string): SparseVector => {
  const { counts } = termCounts(text)
  const indices = [...counts.keys()].sort((a, b) => a - b)
  return {
    indices,
    values: indices.map(index => counts.get(index) ?? 0)
  }
}

/** Document-side sparse vector. `avgDocTokens` is the corpus average length used by BM25 normalisation. */
const toDocumentSparseVector = (text: string, weighting: SparseWeighting, avgDocTokens: number): SparseVector => {
  if (weighting === "tf") return toSparseVector(text)

  const { counts, length } = termCounts(text)
  const indices = [...counts.keys()].sort((a, b) => a - b)
  const norm = BM25_K1 * (1 - BM25_B + (BM25_B * length) / avgDocTokens)
  return {
    indices,
    values: indices.map(index => {
      const tf = counts.get(index) ?? 0
      return (tf * (BM25_K1 + 1)) / (tf + norm)
    })
  }
}

export type { SparseVector, SparseWeighting }
export { termIndex, toDocumentSparseVector, tokenize, toSparseVector }
