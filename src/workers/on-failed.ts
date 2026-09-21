import type { Job } from "bullmq"
import { documentStore } from "../db/document.store"
import type { DocumentJob } from "../queue/jobs"

const markFailedIfExhausted = async (job: Job<DocumentJob> | undefined, error: Error): Promise<void> => {
  if (!job) return
  const attempts = job.opts.attempts ?? 1
  if (job.attemptsMade < attempts) return

  try {
    await documentStore.updateStatus(job.data.documentId, "failed", error.message)
  } catch (statusError) {
    console.error(`Could not mark document ${job.data.documentId} as failed`, statusError)
  }
}

export { markFailedIfExhausted }
