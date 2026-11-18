import { expect, test } from "bun:test"
import { captureRuntimeMetadata, inferenceEnvironmentHints, parseProcessLimits } from "./runtime-metadata"

test("only typed thread hints are captured, never unknown environment or arbitrary allowlisted strings", () => {
  const result = inferenceEnvironmentHints({
    OMP_NUM_THREADS: "4",
    ORT_NUM_THREADS: "secret-value",
    UV_THREADPOOL_SIZE: "999999999999999999",
    REDIS_URL: "secret-url",
    PRIVATE_KEY: "secret-key"
  })
  expect(result.OMP_NUM_THREADS).toBe(4)
  expect(result.ORT_NUM_THREADS).toBe("invalid-or-redacted")
  expect(result.UV_THREADPOOL_SIZE).toBe("invalid-or-redacted")
  expect(result.MKL_NUM_THREADS).toBeNull()
  expect(JSON.stringify(result)).not.toContain("secret")
  expect(result).not.toHaveProperty("REDIS_URL")
})
test("process limits parse only allowlisted numeric/unlimited fields", () => {
  const result = parseProcessLimits(
    "Max open files            1024                 4096                 files\nMax processes             unlimited            unlimited            processes\nMax address space         private-token        999999999999999999999 bytes\nSecret line secret\n"
  )
  expect(result["Max open files"]).toEqual({ soft: 1024, hard: 4096 })
  expect(result["Max processes"]).toEqual({ soft: "unlimited", hard: "unlimited" })
  expect(result["Max address space"]).toEqual({ soft: null, hard: null })
  expect(JSON.stringify(result)).not.toContain("private-token")
  expect(Object.keys(result)).toHaveLength(3)
})
test("snapshot is serializable, reports actual session unknown and truthful service declarations", () => {
  const result = captureRuntimeMetadata()
  expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  expect(Number.isFinite(Date.parse(result.capturedAt))).toBe(true)
  expect(result.platform).toBe(process.platform)
  expect(result.arch).toBe(process.arch)
  expect(result.bun).toBe(Bun.version)
  expect(result.hardware.logicalCpus).toBeGreaterThan(0)
  expect(result.hardware.totalMemoryBytes).toBeGreaterThan(0)
  expect(result.inference.actualSession.backend).toBeNull()
  expect(result.inference.actualSession.dtype).toBeNull()
  expect(result.inference.embedding.dtype).toBeNull()
  expect(result.inference.embedding.padding).toBeNull()
  expect(result.inference.reranker).toMatchObject({
    dtype: "q8",
    padding: true,
    truncation: true,
    batchSize: null,
    threadSettings: null
  })
  for (const value of result.hostLoadAverage.values) expect(Number.isFinite(value)).toBe(true)
  expect(result).not.toHaveProperty("hostname")
  expect(result).not.toHaveProperty("argv")
  expect(result).not.toHaveProperty("cwd")
})
