import { pipeline } from "@huggingface/transformers"
import { env } from "../../config/env"
import type { EmbeddingPort } from "../../domain/embedding"
import { CachedEmbeddingService } from "./cache"

type FeatureExtractor = (input: string | string[], options: { pooling: "mean"; normalize: boolean }) => Promise<unknown>

class HuggingFaceEmbeddingService implements EmbeddingPort {
  readonly modelId: string
  readonly dimensions: number
  private extractor: FeatureExtractor | null = null
  private loading: Promise<FeatureExtractor> | null = null

  constructor(modelId: string, dimensions: number) {
    this.modelId = modelId
    this.dimensions = dimensions
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text])
    if (!vector) {
      throw new Error(`Embedding model ${this.modelId} returned no vector`)
    }
    return vector
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const extractor = await this.getExtractor()
    const output = await extractor(texts, {
      pooling: "mean",
      normalize: true
    })

    const vectors = this.toVectors(output)
    if (vectors.length !== texts.length) {
      throw new Error(`Embedding batch size mismatch: input ${texts.length}, output ${vectors.length}`)
    }

    for (const vector of vectors) {
      if (vector.length !== this.dimensions) {
        throw new Error(
          `Embedding size ${vector.length} does not match VECTOR_SIZE=${this.dimensions} for ${this.modelId}`
        )
      }
    }

    return vectors
  }

  private async getExtractor(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor
    if (!this.loading) {
      this.loading = pipeline("feature-extraction", this.modelId).then(extractor => {
        this.extractor = extractor as unknown as FeatureExtractor
        return this.extractor
      })
    }
    return this.loading
  }

  private toVectors(output: unknown): number[][] {
    const tensor = output as { data?: ArrayLike<number>; dims?: number[] }
    if (!tensor.data) {
      throw new Error(`Embedding model ${this.modelId} returned an empty tensor`)
    }

    const data = Array.from(tensor.data)
    if (data.length === this.dimensions) {
      return [data]
    }
    if (data.length % this.dimensions !== 0) {
      throw new Error(`Tensor length ${data.length} is not divisible by VECTOR_SIZE=${this.dimensions}`)
    }

    const vectors: number[][] = []
    for (let i = 0; i < data.length; i += this.dimensions) {
      vectors.push(data.slice(i, i + this.dimensions))
    }
    return vectors
  }
}

let instance: EmbeddingPort | null = null

const getEmbeddingService = (): EmbeddingPort => {
  if (!instance) {
    const raw = new HuggingFaceEmbeddingService(env.embeddingModel, env.vectorSize)
    instance = env.embeddingCacheSize > 0 ? new CachedEmbeddingService(raw, env.embeddingCacheSize) : raw
  }
  return instance
}

const warmupEmbeddings = async (): Promise<void> => {
  await getEmbeddingService().embed("warmup")
}

export { getEmbeddingService, HuggingFaceEmbeddingService, warmupEmbeddings }
