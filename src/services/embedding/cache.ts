import type { EmbeddingPort } from "../../domain/embedding"

class CachedEmbeddingService implements EmbeddingPort {
  readonly modelId: string
  readonly dimensions: number
  private readonly cache = new Map<string, number[]>()

  constructor(
    private readonly inner: EmbeddingPort,
    private readonly maxSize: number
  ) {
    this.modelId = inner.modelId
    this.dimensions = inner.dimensions
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text)
    if (cached) {
      this.cache.delete(text)
      this.cache.set(text, cached)
      return cached
    }

    const vector = await this.inner.embed(text)
    this.remember(text, vector)
    return vector
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const missingIndexes: number[] = []
    const missingTexts: string[] = []
    const result: Array<number[] | undefined> = texts.map((text, index) => {
      const cached = this.cache.get(text)
      if (cached) return cached
      missingIndexes.push(index)
      missingTexts.push(text)
      return undefined
    })

    if (missingTexts.length > 0) {
      const computed = await this.inner.embedBatch(missingTexts)
      computed.forEach((vector, offset) => {
        const index = missingIndexes[offset] ?? 0
        const text = missingTexts[offset] ?? ""
        result[index] = vector
        this.remember(text, vector)
      })
    }

    return result.map((vector, index) => {
      if (!vector) {
        throw new Error(`Embedding batch produced no vector for input at index ${index}`)
      }
      return vector
    })
  }

  private remember(text: string, vector: number[]): void {
    if (this.maxSize <= 0) return
    this.cache.set(text, vector)
    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}

export { CachedEmbeddingService }
