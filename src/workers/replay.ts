import { documentStore } from "../db/document.store"
import { clearPipelineJobs, enqueueIngest } from "../queue/queues"

const documentId = process.argv[2]

if (!documentId) {
  console.error("Usage: bun src/workers/replay.ts <documentId>")
  process.exit(1)
}

const document = await documentStore.require(documentId)
await clearPipelineJobs(document.id)
await documentStore.updateStatus(document.id, "queued")
await enqueueIngest(document.id)
console.log(`Re-queued ingest for ${document.id}`)
process.exit(0)
