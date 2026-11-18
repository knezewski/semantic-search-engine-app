import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { METRICS_VERSION } from "./metrics"
import { createEvalRun, modelIdentity, safeEndpoint, sha256, validateFixtures } from "./run-context"
import { sampleQueries } from "./sampling"
import type { EvalDocument, EvalQuery } from "./types"

const corpus: EvalDocument[] = [
  { id: "a", title: "First", text: "Alpha document." },
  { id: "b", title: "Second", text: "Beta document.", source: "local" }
]
const dataset: EvalQuery[] = [
  { id: "q1", query: "find alpha", relevantDocumentIds: ["a"] },
  { id: "q2", query: "find beta", relevantDocumentIds: ["b"] },
  { id: "q3", query: "find both", relevantDocumentIds: ["a", "b"] },
  { id: "q4", query: "duplicate labels", relevantDocumentIds: ["a", "a"] },
  { id: "q5", query: "unanswerable query", relevantDocumentIds: [] }
]

const cleanupTemporaryRoot = async (root: string, temporaryParent: string, prefix: string): Promise<void> => {
  // Only remove the exact, real mkdtemp child we created, never a computed or widened root.
  const target = await realpath(root)
  if (target !== resolve(root) || dirname(target) !== temporaryParent || !basename(target).startsWith(prefix)) {
    throw new Error(`Refusing unsafe temporary-directory cleanup: ${target}`)
  }
  await rm(target, { recursive: true })
}

const withFixtures = async (
  run: (paths: {
    root: string
    fixtureDir: string
    outputRoot: string
    corpusBytes: string
    datasetBytes: string
  }) => Promise<void>
): Promise<void> => {
  const temporaryParent = await realpath(tmpdir())
  const prefix = "semantic-eval-context-test-"
  const root = await mkdtemp(join(temporaryParent, prefix))
  try {
    const fixtureDir = join(root, "fixtures")
    const outputRoot = join(root, "runs")
    await mkdir(fixtureDir)
    // Whitespace is deliberate: provenance hashes must describe exact bytes, not reserialized JSON.
    const corpusBytes = `${JSON.stringify(corpus, null, 2)}\n\n`
    const datasetBytes = ` ${JSON.stringify(dataset)}\n`
    await Bun.write(join(fixtureDir, "corpus.json"), corpusBytes)
    await Bun.write(join(fixtureDir, "dataset.json"), datasetBytes)
    await run({ root, fixtureDir, outputRoot, corpusBytes, datasetBytes })
  } finally {
    await cleanupTemporaryRoot(root, temporaryParent, prefix)
  }
}

const explicitOptions = (fixtureDir: string, outputRoot: string) => ({
  fixtureDir,
  outputRoot,
  seed: 123,
  queryCap: 3,
  bootstrapResamples: 17
})

describe("fixture validation", () => {
  test("accepts gold duplicates and unanswerable queries", () => {
    expect(() => validateFixtures(corpus, dataset)).not.toThrow()
  })

  test("rejects empty inputs, duplicate IDs, blank IDs, invalid text and missing gold", () => {
    expect(() => validateFixtures([], dataset)).toThrow("nonempty")
    expect(() => validateFixtures(corpus, [])).toThrow("nonempty")
    expect(() => validateFixtures([...corpus, corpus[0]], dataset)).toThrow("unique")
    expect(() => validateFixtures(corpus, [...dataset, dataset[0]])).toThrow("unique")
    expect(() => validateFixtures([{ ...corpus[0], id: " " }], dataset)).toThrow("nonempty")
    expect(() => validateFixtures(corpus, [{ ...dataset[0], id: "" }])).toThrow("nonempty")
    expect(() => validateFixtures(corpus, [{ ...dataset[0], query: " \t " }])).toThrow("Invalid query")
    expect(() => validateFixtures(corpus, [{ ...dataset[0], relevantDocumentIds: ["missing"] }])).toThrow(
      "missing from corpus"
    )
    expect(() => validateFixtures([{ ...corpus[0], text: 3 } as unknown as EvalDocument], [])).toThrow()
    expect(() => validateFixtures([{ ...corpus[0], text: 3 } as unknown as EvalDocument], [dataset[0]])).toThrow(
      "Invalid corpus"
    )
    expect(() =>
      validateFixtures(corpus, [{ ...dataset[0], relevantDocumentIds: null } as unknown as EvalQuery])
    ).toThrow("Invalid query")
  })
})

describe("manifest provenance helpers", () => {
  test("hashes exact UTF-8 bytes and byte arrays with SHA-256", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(sha256(new TextEncoder().encode("abc"))).toBe(sha256("abc"))
    expect(sha256("abc\n")).not.toBe(sha256("abc"))
  })

  test("safeEndpoint removes credentials, paths, queries and fragments", () => {
    expect(safeEndpoint("https://alice:password@example.test:6333/api/token?api_key=secret#fragment")).toBe(
      "https://example.test:6333"
    )
    expect(safeEndpoint("http://localhost:6333/path-secret")).toBe("http://localhost:6333")
    expect(safeEndpoint("https://example.test/one/two")).toBe("https://example.test")
    expect(safeEndpoint("not a URL containing secrets")).toBe("invalid-url")
  })

  test("revision identity distinguishes requests from actually resolved immutable artifacts", () => {
    for (const revision of [undefined, "main", "v1.2.3", "deadbeef", "a".repeat(39), "g".repeat(40)]) {
      const identity = modelIdentity("local/model", revision)
      expect(identity.id).toBe("local/model")
      expect(identity.requestedRevision).toBe(revision ?? "main")
      expect(identity.immutableRevision).toBeNull()
      expect(identity.resolvedRevision).toBeNull()
      expect(identity.note).toContain("does not expose")
    }
    for (const revision of ["a".repeat(40), "ABCDEF01".repeat(5)]) {
      const identity = modelIdentity("local/model", revision)
      expect(identity.requestedRevision).toBe(revision)
      expect(identity.immutableRevision).toBe(revision)
      expect(identity.resolvedRevision).toBeNull()
    }
  })
})

describe("createEvalRun", () => {
  test("hashes raw fixtures, records deterministic selected IDs, and creates unique run artifacts", async () => {
    await withFixtures(async ({ fixtureDir, outputRoot, corpusBytes, datasetBytes }) => {
      const options = explicitOptions(fixtureDir, outputRoot)
      const first = await createEvalRun("offline-test", { topK: 10 }, options)
      const second = await createEvalRun("offline-test", { topK: 10 }, options)
      expect(first.corpus).toEqual(corpus)
      expect(first.dataset).toEqual(sampleQueries(dataset, 3, 123))
      expect(first.dataset).toEqual(second.dataset)
      expect(first.seed).toBe(123)
      expect(first.bootstrapOptions).toEqual({ seed: 123, resamples: 17, confidence: 0.95 })
      expect(first.outputDir).not.toBe(second.outputDir)
      expect(dirname(first.outputDir)).toBe(resolve(outputRoot))
      expect(first.manifest.runId).not.toBe(second.manifest.runId)
      expect(first.manifest.metricsVersion).toBe(METRICS_VERSION)
      expect(first.manifest.fixtures).toEqual({
        set: "custom",
        corpusSha256: createHash("sha256").update(corpusBytes).digest("hex"),
        datasetSha256: createHash("sha256").update(datasetBytes).digest("hex"),
        documents: 2,
        availableQueries: 5
      })
      expect(first.manifest.sampling).toEqual({
        algorithm: "seeded-fisher-yates-v1",
        seed: 123,
        queryCap: 3,
        selectedQueryIds: first.dataset.map(item => item.id)
      })
      expect(first.manifest.bootstrap).toMatchObject({
        seed: 123,
        resamples: 17,
        confidence: 0.95,
        method: "paired-percentile",
        delta: "variant-minus-baseline",
        multiplicityAdjusted: false
      })
      expect(await Bun.file(join(first.outputDir, "manifest.json")).json()).toEqual(first.manifest)
      expect(first.manifest.status).toBe("running")
      expect(first.manifest.completedAt).toBeNull()
      expect(first.manifest.evaluation).toMatchObject({ topK: 10, unit: "document", mrrCutoff: 10 })
      expect(first.manifest.runtime.bun).toBe(Bun.version)
      expect(first.manifest.environment.initial.inference.actualSession.backend).toBeNull()
      expect(first.manifest.environment.initial.inference.reranker.dtype).toBe("q8")
      expect(first.manifest.environment.final).toBeNull()
      expect(first.manifest.git.sha === null || /^[a-f\d]{40}$/i.test(first.manifest.git.sha)).toBe(true)
      expect(first.manifest.git.dirty === null || typeof first.manifest.git.dirty === "boolean").toBe(true)
    })
  })

  test("zero query cap preserves the complete validated dataset including empty and duplicate gold", async () => {
    await withFixtures(async ({ fixtureDir, outputRoot }) => {
      const run = await createEvalRun("all-queries", {}, { ...explicitOptions(fixtureDir, outputRoot), queryCap: 0 })
      expect(run.dataset).toEqual(dataset)
      expect(run.manifest.sampling.selectedQueryIds).toEqual(dataset.map(item => item.id))
    })
  })

  test("registers isolated collection names eagerly, before any Qdrant capture", async () => {
    await withFixtures(async ({ fixtureDir, outputRoot }) => {
      const options = explicitOptions(fixtureDir, outputRoot)
      const first = await createEvalRun("collections", {}, options)
      const second = await createEvalRun("collections", {}, options)
      const main = first.collection()
      const alternate = first.collection("alternate-2")
      expect(first.collection()).toBe(main)
      expect(main).not.toBe(alternate)
      expect(second.collection()).not.toBe(main)
      const registered = await Bun.file(join(first.outputDir, "manifest.json")).json()
      expect(registered.qdrant.collections).toEqual([main, alternate])
      expect(registered.qdrant.version).toBeNull()
      expect(main).toMatch(/^eval_collections_[a-f\d]{32}_main$/)
      for (const suffix of ["", "../escape", "space name", "bad/slash"]) {
        expect(() => first.collection(suffix)).toThrow("Invalid collection suffix")
      }
      let captured = false
      await first.captureQdrant({
        async versionInfo() {
          captured = true
          const persisted = await Bun.file(join(first.outputDir, "manifest.json")).json()
          expect(persisted.qdrant.collections).toEqual([main, alternate])
          return { title: "fake-local", version: "offline-1" }
        }
      })
      expect(captured).toBe(true)
      expect((await Bun.file(join(first.outputDir, "manifest.json")).json()).qdrant.version).toEqual({
        title: "fake-local",
        version: "offline-1"
      })
    })
  })

  test("keeps eager collection cleanup records even when version capture fails", async () => {
    await withFixtures(async ({ fixtureDir, outputRoot }) => {
      const run = await createEvalRun("capture-failure", {}, explicitOptions(fixtureDir, outputRoot))
      const name = run.collection()
      await expect(
        run.captureQdrant({
          async versionInfo() {
            throw new Error("offline failure")
          }
        })
      ).rejects.toThrow("offline failure")
      const persisted = await Bun.file(join(run.outputDir, "manifest.json")).json()
      expect(persisted.qdrant.collections).toEqual([name])
      expect(persisted.qdrant.version).toBeNull()
      expect(persisted.status).toBe("running")
    })
  })

  test("whitelists configuration instead of dumping environment or credentials", async () => {
    await withFixtures(async ({ fixtureDir, outputRoot }) => {
      const key = "EVAL_CONTEXT_TEST_PRIVATE_TOKEN"
      const previous = process.env[key]
      process.env[key] = "do-not-persist-context-secret-789"
      try {
        const run = await createEvalRun("redaction", {}, explicitOptions(fixtureDir, outputRoot))
        const text = await Bun.file(join(run.outputDir, "manifest.json")).text()
        expect(text).not.toContain(key)
        expect(text).not.toContain("do-not-persist-context-secret-789")
        expect(Object.keys(run.manifest.config).sort()).toEqual(
          [
            "vectorSize",
            "chunkSize",
            "chunkOverlap",
            "searchHnswEf",
            "embeddingCacheSize",
            "sparseWeighting",
            "sparseAvgDocTokens",
            "rrfK",
            "rrfDenseWeight",
            "rrfSparseWeight",
            "rerankCandidates",
            "rerankEnabled"
          ].sort()
        )
        expect(run.manifest.config).not.toHaveProperty("qdrantApiKey")
        expect(run.manifest.config).not.toHaveProperty("redisUrl")
        expect(run.manifest.config).not.toHaveProperty("sqlitePath")
        expect(run.manifest.qdrant.endpoint).toBe(safeEndpoint(run.manifest.qdrant.endpoint))
        expect(run.manifest.models.embedding.resolvedRevision).toBeNull()
        expect(run.manifest.models.tokenizer).toEqual(run.manifest.models.embedding)
        expect(run.manifest.models.executionBackend).toContain("not independently verified")
      } finally {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }
    })
  })

  test("writes completed unrounded result evidence and matching completed manifest", async () => {
    await withFixtures(async ({ fixtureDir, outputRoot }) => {
      const run = await createEvalRun("completion", {}, explicitOptions(fixtureDir, outputRoot))
      const collection = run.collection()
      const evidence = { value: 1 / 3, rows: [{ id: "q1", score: 0.12345678901234566 }] }
      const path = await run.writeResults(evidence)
      expect(path).toBe(join(run.outputDir, "results.json"))
      const result = await Bun.file(path).json()
      const manifest = await Bun.file(join(run.outputDir, "manifest.json")).json()
      expect(result.value).toBe(1 / 3)
      expect(result.rows).toEqual(evidence.rows)
      expect(result.manifest).toEqual(manifest)
      expect(manifest).toEqual(run.manifest)
      expect(manifest.status).toBe("completed")
      expect(manifest.environment.final).not.toBeNull()
      expect(manifest.environment.final.inference.actualSession.backend).toBeNull()
      expect(Date.parse(manifest.environment.final.capturedAt)).toBeGreaterThanOrEqual(
        Date.parse(manifest.environment.initial.capturedAt)
      )
      expect(Number.isFinite(Date.parse(manifest.completedAt))).toBe(true)
      expect(manifest.qdrant.collections).toEqual([collection])
      expect((await readdir(run.outputDir)).sort()).toEqual(["manifest.json", "results.json"])
    })
  })

  test("rejects invalid explicit options and fixtures before creating output artifacts", async () => {
    await withFixtures(async ({ fixtureDir, outputRoot }) => {
      const options = explicitOptions(fixtureDir, outputRoot)
      for (const seed of [-1, 0.5, NaN, Infinity, 0x100000000]) {
        await expect(createEvalRun("invalid", {}, { ...options, seed })).rejects.toThrow("Invalid seed")
      }
      for (const queryCap of [-1, 0.5, NaN, Infinity]) {
        await expect(createEvalRun("invalid", {}, { ...options, queryCap })).rejects.toThrow("Invalid query cap")
      }
      for (const bootstrapResamples of [0, -1, 0.5, NaN, Infinity]) {
        await expect(createEvalRun("invalid", {}, { ...options, bootstrapResamples })).rejects.toThrow(
          "Invalid bootstrap"
        )
      }
      await expect(createEvalRun("../escape", {}, options)).rejects.toThrow("Invalid evaluation kind")
      await Bun.write(
        join(fixtureDir, "dataset.json"),
        JSON.stringify([{ ...dataset[0], relevantDocumentIds: ["missing"] }])
      )
      await expect(createEvalRun("invalid-fixtures", {}, options)).rejects.toThrow("missing from corpus")
      expect(await Bun.file(join(outputRoot, "manifest.json")).exists()).toBe(false)
      await expect(readdir(outputRoot)).rejects.toThrow()
    })
  })
})
