import { notFoundError } from "../../api/errors"
import { documentStore } from "../../db/document.store"
import { createDocumentRecord, type DocumentRecord } from "../../domain/document"
import { enqueueIngest } from "../../queue/queues"
import type { DocumentCreateInput } from "../../validation/document.schema"

const submitDocument = async (input: DocumentCreateInput): Promise<DocumentRecord> => {
  const document = createDocumentRecord(input)
  await documentStore.save(document)
  try {
    await enqueueIngest(document.id)
  } catch (error) {
    // Do not leave the document stuck in "queued" if Redis is unavailable.
    await documentStore.updateStatus(document.id, "failed", "Failed to enqueue ingest job")
    throw error
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

export { getDocument, submitDocument }
