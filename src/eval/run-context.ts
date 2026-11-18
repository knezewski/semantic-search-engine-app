import { createHash, randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { QdrantClient } from "@qdrant/js-client-rest"
import { env } from "../config/env"
import { EVAL_FIXTURE_SET, fixtureDirectory } from "./fixtures"
import { METRICS_VERSION } from "./metrics"
import { captureRuntimeMetadata, type RuntimeMetadata } from "./runtime-metadata"
import { readIntegerOption, sampleQueries } from "./sampling"
import type { EvalDocument, EvalQuery } from "./types"

const PROJECT_ROOT = resolve(import.meta.dir, "../..")
const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex")

/** Never persist credentials, query strings or path-based API tokens. */
const safeEndpoint = (endpoint: string): string => {
  try {
    return new URL(endpoint).origin
  } catch {
    return "invalid-url"
  }
}

const modelIdentity = (id: string, revision?: string) => ({
  id,
  requestedRevision: revision ?? "main",
  immutableRevision: revision && /^[a-f\d]{40}$/i.test(revision) ? revision : null,
  resolvedRevision: null,
  note: "Only a supplied full commit SHA is immutable; runtime does not expose the resolved artifact commit."
})

const validateFixtures = (corpus: EvalDocument[], dataset: EvalQuery[]): void => {
  if (!Array.isArray(corpus) || !Array.isArray(dataset) || !corpus.length || !dataset.length) {
    throw new Error("Evaluation requires nonempty corpus and dataset arrays")
  }
  const documentIds = new Set<string>()
  for (const document of corpus) {
    if (!document || typeof document.id !== "string" || !document.id.trim() || documentIds.has(document.id)) {
      throw new Error("Corpus document IDs must be nonempty and unique")
    }
    if (typeof document.text !== "string" || typeof document.title !== "string") {
      throw new Error(`Invalid corpus document ${document.id}`)
    }
    documentIds.add(document.id)
  }
  const queryIds = new Set<string>()
  for (const query of dataset) {
    if (!query || typeof query.id !== "string" || !query.id.trim() || queryIds.has(query.id)) {
      throw new Error("Dataset query IDs must be nonempty and unique")
    }
    if (typeof query.query !== "string" || !query.query.trim() || !Array.isArray(query.relevantDocumentIds)) {
      throw new Error(`Invalid query ${query.id}`)
    }
    for (const id of query.relevantDocumentIds) {
      if (!documentIds.has(id)) throw new Error(`Gold document ${id} for ${query.id} is missing from corpus`)
    }
    queryIds.add(query.id)
  }
}

const gitOutput = (args: string[]): string | null => {
  const result = Bun.spawnSync(["git", ...args], { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

interface RunOptions {
  fixtureDir?: string
  outputRoot?: string
  seed?: number
  queryCap?: number
  bootstrapResamples?: number
}

/** No model loading or network access. Fixture bytes are hashed before parsing. */
const createEvalRun = async (kind: string, settings: Record<string, unknown>, options: RunOptions = {}) => {
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new Error("Invalid evaluation kind")
  const seed = options.seed ?? readIntegerOption("EVAL_SEED", 42, 0, 0xffffffff)
  const queryCap = options.queryCap ?? readIntegerOption("EVAL_QUERIES", 0)
  const resamples = options.bootstrapResamples ?? readIntegerOption("EVAL_BOOTSTRAP_RESAMPLES", 2000, 1)
  // Validate explicit options too, before creating artifacts or making any network requests.
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Invalid seed")
  if (!Number.isSafeInteger(queryCap) || queryCap < 0) throw new Error("Invalid query cap")
  if (!Number.isSafeInteger(resamples) || resamples < 1) throw new Error("Invalid bootstrap resample count")
  const directory = options.fixtureDir ?? fixtureDirectory()
  const corpusBytes = await Bun.file(join(directory, "corpus.json")).text()
  const datasetBytes = await Bun.file(join(directory, "dataset.json")).text()
  const corpus = JSON.parse(corpusBytes) as EvalDocument[]
  const allQueries = JSON.parse(datasetBytes) as EvalQuery[]
  validateFixtures(corpus, allQueries)
  const dataset = sampleQueries(allQueries, queryCap, seed)
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}-${randomUUID()}`
  const outputDir = resolve(options.outputRoot ?? join(PROJECT_ROOT, "eval-runs"), runId)
  await mkdir(resolve(outputDir, ".."), { recursive: true })
  await mkdir(outputDir) // Exclusive: a run never overwrites an existing directory.
  const bootstrapOptions = { seed, resamples, confidence: 0.95 }
  const packageJson = await Bun.file(join(PROJECT_ROOT, "package.json")).json()
  const dependencies: Record<string, string | null> = {}
  for (const name of Object.keys(packageJson.dependencies ?? {})) {
    const file = Bun.file(join(PROJECT_ROOT, "node_modules", name, "package.json"))
    dependencies[name] = (await file.exists()) ? (await file.json()).version : null
  }
  const lockfile = Bun.file(join(PROJECT_ROOT, "bun.lock"))
  const gitStatus = gitOutput(["status", "--porcelain"])
  const manifest = {
    schemaVersion: 2,
    metricsVersion: METRICS_VERSION,
    runId,
    kind,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null as string | null,
    git: { sha: gitOutput(["rev-parse", "HEAD"]), dirty: gitStatus === null ? null : gitStatus.length > 0 },
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, dependencies },
    environment: { initial: captureRuntimeMetadata(), final: null as RuntimeMetadata | null },
    lockfileSha256: (await lockfile.exists()) ? sha256(await lockfile.bytes()) : null,
    fixtures: {
      set: options.fixtureDir ? "custom" : EVAL_FIXTURE_SET || "smoke",
      corpusSha256: sha256(corpusBytes),
      datasetSha256: sha256(datasetBytes),
      documents: corpus.length,
      availableQueries: allQueries.length
    },
    sampling: { algorithm: "seeded-fisher-yates-v1", seed, queryCap, selectedQueryIds: dataset.map(q => q.id) },
    bootstrap: {
      ...bootstrapOptions,
      method: "paired-percentile",
      delta: "variant-minus-baseline",
      multiplicityAdjusted: false
    },
    evaluation: {
      unit: "document",
      relevance: "binary",
      depthPolicy: "deduplicate-within-returned-chunks-no-backfill",
      mrrCutoff: 10,
      unanswerablePolicy: "zero-retrieval-metrics-not-an-abstention-evaluation",
      ...settings
    },
    models: {
      embedding: modelIdentity(env.embeddingModel, env.embeddingRevision),
      tokenizer: modelIdentity(env.embeddingModel, env.embeddingRevision),
      reranker: modelIdentity(env.rerankModel, env.rerankRevision),
      executionBackend: "auto (not independently verified)",
      rerankerDtype: "q8"
    },
    config: {
      vectorSize: env.vectorSize,
      chunkSize: env.chunkSize,
      chunkOverlap: env.chunkOverlap,
      searchHnswEf: env.searchHnswEf,
      embeddingCacheSize: env.embeddingCacheSize,
      sparseWeighting: env.sparseWeighting,
      sparseAvgDocTokens: env.sparseAvgDocTokens,
      rrfK: env.rrfK,
      rrfDenseWeight: env.rrfDenseWeight,
      rrfSparseWeight: env.rrfSparseWeight,
      rerankCandidates: env.rerankCandidates,
      rerankEnabled: env.rerankEnabled
    },
    qdrant: { endpoint: safeEndpoint(env.qdrantUrl), version: null as unknown, collections: [] as string[] },
    warnings: [
      "Historical metric-v1 results are not comparable; rerun retrieval because old artifacts lack ranked IDs.",
      "Approximate search and auto-selected inference backends may vary across runs.",
      "Bootstrap intervals reflect query sampling only; they are exploratory, not corrected for multiple comparisons.",
      "Pin model revisions to full commit SHAs for reproducible artifacts; unresolved revisions are explicitly null."
    ]
  }
  const persistManifest = () => Bun.write(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  await persistManifest()
  const names = new Map<string, string>()
  return {
    corpus,
    dataset,
    seed,
    bootstrapOptions,
    manifest,
    outputDir,
    collection(suffix = "main"): string {
      if (!/^[a-zA-Z0-9_-]+$/.test(suffix)) throw new Error("Invalid collection suffix")
      const previous = names.get(suffix)
      if (previous) return previous
      const name = `eval_${kind}_${runId.slice(-36).replaceAll("-", "")}_${suffix}`
      names.set(suffix, name)
      manifest.qdrant.collections.push(name)
      // Registration is synchronous so even a subsequent indexing failure leaves a cleanup record.
      writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
      return name
    },
    async captureQdrant(client: Pick<QdrantClient, "versionInfo">): Promise<void> {
      // Persist collection names before potentially failing network/model operations.
      await persistManifest()
      manifest.qdrant.version = await client.versionInfo()
      await persistManifest()
    },
    async writeResults(results: Record<string, unknown>): Promise<string> {
      const path = join(outputDir, "results.json")
      const completedAt = new Date().toISOString()
      manifest.environment.final = captureRuntimeMetadata()
      await Bun.write(
        path,
        `${JSON.stringify({ ...results, manifest: { ...manifest, status: "completed", completedAt } }, null, 2)}\n`
      )
      manifest.status = "completed"
      manifest.completedAt = completedAt
      await persistManifest()
      return path
    }
  }
}

type EvalRun = Awaited<ReturnType<typeof createEvalRun>>

export type { EvalRun }
export { createEvalRun, modelIdentity, safeEndpoint, sha256, validateFixtures }
