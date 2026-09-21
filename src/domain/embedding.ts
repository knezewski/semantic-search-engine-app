/**
 * Embedding is a replaceable dependency. The rest of the pipeline
 * only needs vectors + the declared dimensionality.
 */
interface EmbeddingPort {
  readonly modelId: string
  readonly dimensions: number
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
}

interface EmbeddedChunk {
  chunkId: string
  documentId: string
  text: string
  title: string
  source?: string
  position: number
  vector: number[]
}

export type { EmbeddedChunk, EmbeddingPort }
