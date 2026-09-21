import { describe, expect, test } from "bun:test"
import { chunkIdFor, pointIdForChunk } from "./hash"

describe("chunk ids", () => {
  test("formats a stable business id", () => {
    expect(chunkIdFor("doc-1", 0)).toBe("doc-1:chunk-0")
    expect(chunkIdFor("doc-1", 2)).toBe("doc-1:chunk-2")
  })

  test("derives a stable UUID point id for Qdrant", () => {
    const chunkId = chunkIdFor("doc-1", 0)
    const first = pointIdForChunk(chunkId)
    const second = pointIdForChunk(chunkId)

    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(pointIdForChunk(chunkIdFor("doc-1", 1))).not.toBe(first)
  })
})
