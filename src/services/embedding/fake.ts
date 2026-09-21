import type { EmbeddingPort } from "../../domain/embedding"

/**
 * Deterministic port for tests. Not a real embedding model.
 */
class FakeEmbeddingService implements EmbeddingPort {
  readonly modelId = "fake"
  readonly dimensions: number

  constructor(dimensions = 4) {
    this.dimensions = dimensions
  }

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0)
    for (let i = 0; i < text.length; i += 1) {
      const slot = i % this.dimensions
      vector[slot] = (vector[slot] ?? 0) + text.charCodeAt(i)
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
    return vector.map(value => value / norm)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(text => this.embed(text)))
  }
}

export { FakeEmbeddingService }
