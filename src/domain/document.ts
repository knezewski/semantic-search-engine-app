type DocumentStatus = "queued" | "chunking" | "embedding" | "indexing" | "ready" | "failed"

interface DocumentRecord {
  id: string
  title: string
  text: string
  source?: string
  status: DocumentStatus
  createdAt: string
  updatedAt: string
  lastError?: string
}

interface DocumentChunk {
  /** Stable business id: `${documentId}:chunk-${position}` */
  chunkId: string
  documentId: string
  text: string
  title: string
  source?: string
  position: number
}

const DOCUMENT_STATUSES: readonly DocumentStatus[] = [
  "queued",
  "chunking",
  "embedding",
  "indexing",
  "ready",
  "failed"
] as const

const createDocumentRecord = (input: { id?: string; title: string; text: string; source?: string }): DocumentRecord => {
  const now = new Date().toISOString()
  return {
    id: input.id ?? crypto.randomUUID(),
    title: input.title,
    text: input.text,
    source: input.source,
    status: "queued",
    createdAt: now,
    updatedAt: now
  }
}

export type { DocumentChunk, DocumentRecord, DocumentStatus }
export { createDocumentRecord, DOCUMENT_STATUSES }
