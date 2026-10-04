import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers"
import { env } from "../../config/env"
import type { RerankPort } from "../../domain/rerank"

type Tokenizer = (texts: string[], options: { text_pair: string[]; padding: boolean; truncation: boolean }) => unknown

type SequenceClassifier = (inputs: unknown) => Promise<{ logits: { tolist(): number[][] } }>

/**
 * Cross-encoder rerankers (e.g. ms-marco) emit a single relevance logit per
 * (query, passage) pair: higher means more relevant. We return the raw logit
 * rather than a softmax probability — with a single output label softmax is
 * always 1.0 and carries no ranking signal. Multi-label heads put the
 * "relevant" class last.
 */
const readRerankScore = (row: number[]): number => {
  if (row.length === 0) return 0
  return row[row.length - 1] ?? 0
}

class HuggingFaceRerankService implements RerankPort {
  readonly modelId: string
  private tokenizer: Tokenizer | null = null
  private classifier: SequenceClassifier | null = null
  private loading: Promise<void> | null = null

  constructor(modelId: string) {
    this.modelId = modelId
  }

  async score(query: string, passages: string[]): Promise<number[]> {
    if (passages.length === 0) return []
    await this.load()

    const tokenizer = this.tokenizer as Tokenizer
    const classifier = this.classifier as SequenceClassifier
    const inputs = tokenizer(
      passages.map(() => query),
      { text_pair: passages, padding: true, truncation: true }
    )
    const { logits } = await classifier(inputs)
    const rows = logits.tolist()
    if (rows.length !== passages.length) {
      throw new Error(`Rerank batch size mismatch: input ${passages.length}, output ${rows.length}`)
    }
    return rows.map(readRerankScore)
  }

  private async load(): Promise<void> {
    if (this.tokenizer && this.classifier) return
    if (!this.loading) {
      this.loading = Promise.all([
        AutoTokenizer.from_pretrained(this.modelId),
        // Quantized weights keep cross-encoder latency down on CPU.
        AutoModelForSequenceClassification.from_pretrained(this.modelId, { dtype: "q8" })
      ]).then(([tokenizer, classifier]) => {
        this.tokenizer = tokenizer as unknown as Tokenizer
        this.classifier = classifier as unknown as SequenceClassifier
      })
    }
    return this.loading
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

export { getRerankService, HuggingFaceRerankService, readRerankScore, warmupRerank }
