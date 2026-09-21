/**
 * Tokenization used for chunk windows.
 * Production uses the embedding model's tokenizer so CHUNK_SIZE is in model tokens.
 */
import { AutoTokenizer } from "@huggingface/transformers"
import { env } from "../config/env"

interface TokenizerPort {
  readonly modelId: string
  encode(text: string): Promise<number[]>
  decode(tokenIds: number[]): Promise<string>
}

class WhitespaceTokenizer implements TokenizerPort {
  readonly modelId = "whitespace"

  async encode(text: string): Promise<number[]> {
    return text
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(word => {
        let hash = 0
        for (let i = 0; i < word.length; i += 1) hash = (hash * 31 + word.charCodeAt(i)) >>> 0
        return hash
      })
  }

  async decode(tokenIds: number[]): Promise<string> {
    return tokenIds.map(id => String(id)).join(" ")
  }
}

class HuggingFaceTokenizer implements TokenizerPort {
  readonly modelId: string
  private tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null
  private loading: Promise<Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>> | null = null

  constructor(modelId: string) {
    this.modelId = modelId
  }

  async encode(text: string): Promise<number[]> {
    const tokenizer = await this.getTokenizer()
    const encoded = await tokenizer(text, { add_special_tokens: false })
    const ids = (encoded as { input_ids?: { data?: ArrayLike<number> } | number[] }).input_ids
    if (!ids) return []
    if (Array.isArray(ids)) return ids.map(id => Number(id))
    if (ids.data) return Array.from(ids.data, id => Number(id))
    return []
  }

  async decode(tokenIds: number[]): Promise<string> {
    const tokenizer = await this.getTokenizer()
    const decoded = await tokenizer.decode(tokenIds, { skip_special_tokens: true })
    return String(decoded).replace(/\s+/g, " ").trim()
  }

  private async getTokenizer() {
    if (this.tokenizer) return this.tokenizer
    if (!this.loading) {
      this.loading = AutoTokenizer.from_pretrained(this.modelId)
    }
    this.tokenizer = await this.loading
    return this.tokenizer
  }
}

let instance: TokenizerPort | null = null

const getTokenizer = (): TokenizerPort => {
  if (!instance) {
    instance = new HuggingFaceTokenizer(env.embeddingModel)
  }
  return instance
}

export type { TokenizerPort }
export { getTokenizer, HuggingFaceTokenizer, WhitespaceTokenizer }
