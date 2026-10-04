import { describe, expect, mock, test } from "bun:test"
import type { DocumentRecord } from "../../domain/document"
import type { SubmitDocumentDeps } from "./submit"

// Keep the unit tests hermetic: the real modules open Redis, BullMQ and SQLite
// connections at import time. Behaviour is driven through the injected deps.
mock.module("../../db/redis.client", () => ({ verifyRedisConnection: async () => undefined }))
mock.module("../../queue/queues", () => ({ enqueueIngest: async () => undefined }))
mock.module("../../db/document.store", () => ({ documentStore: {} }))

const { submitDocument } = await import("./submit")

const buildDeps = (overrides: Partial<SubmitDocumentDeps> = {}) => {
  const saved: DocumentRecord[] = []
  const failed: Array<{ id: string; lastError: string }> = []
  const deps: SubmitDocumentDeps = {
    saveDocument: async document => {
      saved.push(document)
    },
    markFailed: async (id, lastError) => {
      failed.push({ id, lastError })
    },
    enqueueIngest: async () => undefined,
    verifyRedis: async () => undefined,
    enqueueTimeoutMs: 20,
    ...overrides
  }
  return { deps, saved, failed }
}

describe("submitDocument", () => {
  test("queues a document when Redis and the queue are healthy", async () => {
    const { deps, saved, failed } = buildDeps()

    const document = await submitDocument({ title: "t", text: "body" }, deps)

    expect(document.status).toBe("queued")
    expect(saved).toHaveLength(1)
    expect(saved[0]?.id).toBe(document.id)
    expect(failed).toHaveLength(0)
  })

  test("marks the document failed and returns NOT_READY when Redis is unreachable", async () => {
    const { deps, failed } = buildDeps({
      verifyRedis: async () => {
        throw new Error("Redis is not reachable")
      }
    })

    const error = await submitDocument({ title: "t", text: "body" }, deps).catch(caught => caught)

    expect(error).toMatchObject({ code: "NOT_READY" })
    expect(failed).toHaveLength(1)
    expect(failed[0]?.lastError).toContain("Redis is not reachable")
  })

  test("fails fast instead of hanging when enqueue never settles", async () => {
    const { deps, failed } = buildDeps({
      enqueueIngest: () => new Promise<void>(() => undefined),
      enqueueTimeoutMs: 20
    })

    const error = await submitDocument({ title: "t", text: "body" }, deps).catch(caught => caught)

    expect(error).toMatchObject({ code: "NOT_READY" })
    expect(failed).toHaveLength(1)
    expect(failed[0]?.lastError).toContain("timed out")
  })
})
