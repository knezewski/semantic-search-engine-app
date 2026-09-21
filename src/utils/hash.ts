import { createHash } from "node:crypto"

/**
 * Qdrant point ids must be a UUID or an unsigned integer.
 * Business chunk ids look like `docUuid:chunk-0`, so we derive a
 * deterministic UUID from that string. Re-upserting the same chunk
 * overwrites the same point instead of creating a duplicate.
 */
const uuidFromString = (value: string): string => {
  const bytes = Buffer.from(createHash("sha1").update(value).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const chunkIdFor = (documentId: string, position: number): string => `${documentId}:chunk-${position}`

const pointIdForChunk = (chunkId: string): string => uuidFromString(chunkId)

export { chunkIdFor, pointIdForChunk, uuidFromString }
