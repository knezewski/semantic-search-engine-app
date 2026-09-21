interface DocumentJob {
  documentId: string
}

const QUEUE_NAMES = {
  ingest: "document-ingest",
  chunk: "chunk-generation",
  embedding: "embedding-generation",
  index: "vector-indexing"
} as const

type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

export type { DocumentJob, QueueName }
export { QUEUE_NAMES }
