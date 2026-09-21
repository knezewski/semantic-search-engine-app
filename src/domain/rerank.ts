interface RerankPort {
  readonly modelId: string
  score(query: string, passages: string[]): Promise<number[]>
}

export type { RerankPort }
