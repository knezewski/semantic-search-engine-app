import { notFoundError, notReadyError } from "../../api/errors"
import { documentStore } from "../../db/document.store"
import { verifyRedisConnection } from "../../db/redis.client"
import { createDocumentRecord, type DocumentRecord } from "../../domain/document"
import { enqueueIngest } from "../../queue/queues"
import { withTimeout } from "../../utils/timeout"
import type { DocumentCreateInput } from "../../validation/document.schema"

/** How long to wait for the ingest job to be accepted before failing the request. */
const ENQUEUE_TIMEOUT_MS = 2000

interface SubmitDocumentDeps {
  saveDocument: (document: DocumentRecord) => Promise<void>
  markFailed: (id: string, lastError: string) => Promise<void>
  enqueueIngest: (documentId: string) => Promise<void>
  verifyRedis: () => Promise<void>
  enqueueTimeoutMs?: number
}

const defaultDeps: SubmitDocumentDeps = {
  saveDocument: document => documentStore.save(document),
  markFailed: async (id, lastError) => {
    await documentStore.updateStatus(id, "failed", lastError)
  },
  enqueueIngest,
  verifyRedis: verifyRedisConnection
}

const submitDocument = async (
  input: DocumentCreateInput,
  deps: SubmitDocumentDeps = defaultDeps
): Promise<DocumentRecord> => {
  const document = createDocumentRecord(input)
  await deps.saveDocument(document)

  try {
    // Fail fast when Redis is down: the BullMQ connection uses
    // maxRetriesPerRequest: null, so queue.add() would otherwise buffer the
    // command in ioredis' offline queue and hang until Redis returns.
    await deps.verifyRedis()
    await withTimeout(
      deps.enqueueIngest(document.id),
      deps.enqueueTimeoutMs ?? ENQUEUE_TIMEOUT_MS,
      "Enqueue ingest timed out"
    )
  } catch (error) {
    // Never leave the document stuck in "queued" when the queue is unavailable.
    const reason = error instanceof Error ? error.message : "unknown error"
    await deps.markFailed(document.id, `Failed to enqueue ingest job: ${reason}`)
    throw notReadyError(`Ingest queue unavailable: ${reason}`)
  }

  return document
}

const getDocument = async (id: string): Promise<DocumentRecord> => {
  const document = await documentStore.get(id)
  if (!document) {
    throw notFoundError(`Document ${id} not found`)
  }
  return document
}

export type { SubmitDocumentDeps }
export { getDocument, submitDocument }
