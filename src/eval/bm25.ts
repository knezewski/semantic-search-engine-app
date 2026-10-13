/**
 * Small in-memory lexical index used by eval tooling (hard-negative mining, hybrid diagnostics).
 * Not used by the serving path.
 */

type Tokenizer = (text: string) => string[]

interface TermIndex {
  documentCount: number
  averageLength: number
  lengths: number[]
  postings: Map<string, Array<[number, number]>>
}

const BM25_K1 = 1.2
const BM25_B = 0.75
const WORD = /[a-z0-9]+/g

const tokenizeWords: Tokenizer = text => text.toLowerCase().match(WORD) ?? []

const buildTermIndex = (texts: string[], tokenize: Tokenizer): TermIndex => {
  const lengths: number[] = []
  const postings = new Map<string, Array<[number, number]>>()

  texts.forEach((text, docIndex) => {
    const tokens = tokenize(text)
    lengths.push(tokens.length)

    const termFrequency = new Map<string, number>()
    for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1)

    for (const [term, frequency] of termFrequency) {
      const list = postings.get(term) ?? []
      list.push([docIndex, frequency])
      postings.set(term, list)
    }
  })

  const totalLength = lengths.reduce((sum, length) => sum + length, 0)
  return {
    documentCount: texts.length,
    averageLength: totalLength / Math.max(texts.length, 1),
    lengths,
    postings
  }
}

const idf = (index: TermIndex, documentFrequency: number): number =>
  Math.log(1 + (index.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5))

/** Okapi BM25 with length normalisation and term-frequency saturation. */
const bm25Scores = (index: TermIndex, queryTokens: string[]): Float64Array => {
  const scores = new Float64Array(index.documentCount)
  for (const term of new Set(queryTokens)) {
    const postings = index.postings.get(term)
    if (!postings) continue

    const weight = idf(index, postings.length)
    for (const [docIndex, frequency] of postings) {
      const length = index.lengths[docIndex] ?? 0
      const norm = BM25_K1 * (1 - BM25_B + (BM25_B * length) / index.averageLength)
      scores[docIndex] = (scores[docIndex] ?? 0) + weight * ((frequency * (BM25_K1 + 1)) / (frequency + norm))
    }
  }
  return scores
}

/**
 * sum(queryTf * docTf * idf): what Qdrant computes for raw term-frequency sparse
 * vectors with `modifier: "idf"` (no length normalisation, no TF saturation).
 */
const tfIdfScores = (index: TermIndex, queryTokens: string[]): Float64Array => {
  const queryTf = new Map<string, number>()
  for (const token of queryTokens) queryTf.set(token, (queryTf.get(token) ?? 0) + 1)

  const scores = new Float64Array(index.documentCount)
  for (const [term, queryFrequency] of queryTf) {
    const postings = index.postings.get(term)
    if (!postings) continue

    const weight = idf(index, postings.length)
    for (const [docIndex, frequency] of postings) {
      scores[docIndex] = (scores[docIndex] ?? 0) + queryFrequency * frequency * weight
    }
  }
  return scores
}

/** Indices of the best-scoring items (score > minScore), best first. Ties keep index order. */
const rankTop = (scores: ArrayLike<number>, limit: number, minScore = 0): number[] => {
  const ranked: number[] = []
  for (let index = 0; index < scores.length; index += 1) {
    if ((scores[index] ?? 0) > minScore) ranked.push(index)
  }
  ranked.sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))
  return ranked.slice(0, limit)
}

export type { TermIndex, Tokenizer }
export { BM25_B, BM25_K1, bm25Scores, buildTermIndex, rankTop, tfIdfScores, tokenizeWords }
