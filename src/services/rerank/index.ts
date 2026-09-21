import { pipeline } from "@huggingface/transformers"
import { env } from "../../config/env"
import type { RerankPort } from "../../domain/rerank"

type Classifier = (input: unknown, options?: { topk?: number }) => Promise<unknown>

class HuggingFaceRerankService implements RerankPort {
  readonly modelId: string
  private classifier: Classifier | null = null
  private loading: Promise<Classifier> | null = null

  constructor(modelId: string) {
    this.modelId = modelId
  }

  async score(query: string, passages: string[]): Promise<number[]> {
    if (passages.length === 0) return []
    const classifier = await this.getClassifier()

    // Prefer a single batched call; fall back to per-passage scoring if the
    // pipeline does not support batched text pairs.
    try {
      const output = await classifier(passages.map(passage => ({ text: query, text_pair: passage })))
      const rows = Array.isArray(output) ? output : [output]
      if (rows.length === passages.length) {
        return rows.map(row => HuggingFaceRerankService.readScore(row))
      }
    } catch {
      // fall through to sequential scoring
    }

    const scores: number[] = []
    for (const passage of passages) {
      const output = await classifier({ text: query, text_pair: passage })
      scores.push(HuggingFaceRerankService.readScore(output))
    }
    return scores
  }

  private async getClassifier(): Promise<Classifier> {
    if (this.classifier) return this.classifier
    if (!this.loading) {
      this.loading = pipeline("text-classification", this.modelId).then(pipe => {
        this.classifier = pipe as unknown as Classifier
        return this.classifier
      })
    }
    return this.loading
  }

  private static readScore(output: unknown): number {
    const rows = Array.isArray(output) ? output : [output]
    const first = rows[0] as { score?: number; label?: string } | undefined
    if (typeof first?.score === "number") {
      if (typeof first.label === "string" && /neg|0/i.test(first.label)) {
        return 1 - first.score
      }
      return first.score
    }
    return 0
  }
}

let instance: RerankPort | null = null

const getRerankService = (): RerankPort => {
  if (!instance) {
    instance = new HuggingFaceRerankService(env.rerankModel)
  }
  return instance
}

const warmupRerank = async (): Promise<void> => {
  if (!env.rerankEnabled) return
  await getRerankService().score("warmup", ["warmup passage"])
}

export { getRerankService, HuggingFaceRerankService, warmupRerank }
