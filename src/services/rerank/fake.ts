import type { RerankPort } from "../../domain/rerank"

class FakeRerankService implements RerankPort {
  readonly modelId = "fake-rerank"

  async score(query: string, passages: string[]): Promise<number[]> {
    const needle = query.toLowerCase()
    return passages.map(passage => {
      const text = passage.toLowerCase()
      if (text.includes(needle)) return 1
      const overlap = needle.split(/\s+/).filter(token => token.length > 2 && text.includes(token)).length
      return overlap / Math.max(needle.split(/\s+/).length, 1)
    })
  }
}

export { FakeRerankService }
