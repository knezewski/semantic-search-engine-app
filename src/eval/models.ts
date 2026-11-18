import { env } from "../config/env"
import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { splitDocument } from "../domain/chunk"
import { createDocumentRecord } from "../domain/document"
import { HuggingFaceTokenizer } from "../domain/tokenizer"
import { HuggingFaceEmbeddingService } from "../services/embedding"
import { VectorService } from "../services/vector"
import { payloadString } from "./helpers"
import { compareQueries, makeQueryResult, summarizeQueries } from "./report"
import { createEvalRun } from "./run-context"

const MODELS = [
  { id: "BAAI/bge-small-en-v1.5", dimensions: 384 },
  { id: "Xenova/all-MiniLM-L6-v2", dimensions: 384 }
] as const

const SEARCH_LIMIT = 10
const BASELINE = MODELS[0].id
const DEPTH_POLICY = "deduplicate-within-returned-chunks-no-backfill"
const SHA_REVISION = /^[a-f0-9]{40}$/i

type EvalRun = Awaited<ReturnType<typeof createEvalRun>>

/** Repository revisions are not interchangeable, even when both are commit SHAs. */
const parseModelRevisions = (raw = process.env.EVAL_MODEL_REVISIONS): Record<string, string> => {
  if (raw === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("EVAL_MODEL_REVISIONS must be a JSON object mapping model IDs to revisions")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("EVAL_MODEL_REVISIONS must be a JSON object mapping model IDs to revisions")
  }
  const revisions: Record<string, string> = {}
  for (const [id, revision] of Object.entries(parsed)) {
    if (!MODELS.some(model => model.id === id)) {
      throw new Error(`EVAL_MODEL_REVISIONS contains unknown model ID ${id}`)
    }
    if (typeof revision !== "string" || !revision.trim() || revision !== revision.trim() || /\s/.test(revision)) {
      throw new Error(`EVAL_MODEL_REVISIONS revision for ${id} must be a nonempty string without whitespace`)
    }
    revisions[id] = revision
  }
  return revisions
}

const evaluateModel = async (run: EvalRun, modelId: string, dimensions: number, requestedRevision: string) => {
  const collection = run.collection(modelId.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40))
  const embeddings = new HuggingFaceEmbeddingService(modelId, dimensions, requestedRevision)
  const tokenizer = new HuggingFaceTokenizer(modelId, requestedRevision)
  const qdrant = getQdrantClient()
  const vectors = new VectorService(qdrant, collection)

  const created = await vectors.ensureCollection(collection, { vectorSize: dimensions })
  if (!created.created) throw new Error(`Refusing to reuse evaluation collection ${collection}`)

  const indexStarted = performance.now()
  let chunkCount = 0
  for (const item of run.corpus) {
    const record = createDocumentRecord({ id: item.id, title: item.title, text: item.text, source: item.source })
    const chunks = await splitDocument(record, { tokenizer, chunkSize: env.chunkSize, chunkOverlap: env.chunkOverlap })
    chunkCount += chunks.length
    const chunkVectors = await embeddings.embedBatch(chunks.map(chunk => chunk.text))
    await vectors.upsertChunks(
      chunks.map((chunk, index) => ({ ...chunk, vector: chunkVectors[index] ?? [] })),
      collection
    )
  }
  const indexMs = performance.now() - indexStarted

  const queryStarted = performance.now()
  const queries = []
  for (const item of run.dataset) {
    const started = performance.now()
    const queryVector = await embeddings.embed(item.query)
    const embedMs = performance.now() - started
    const searchStarted = performance.now()
    const hits = await vectors.searchChunks({ vector: queryVector, limit: SEARCH_LIMIT })
    const qdrantMs = performance.now() - searchStarted
    queries.push(
      makeQueryResult(
        item,
        hits.slice(0, SEARCH_LIMIT).map(hit => ({
          documentId: payloadString(hit.payload, "documentId"),
          chunkId: payloadString(hit.payload, "chunkId"),
          score: hit.score
        })),
        { timingMs: { embedMs, qdrantMs, totalMs: performance.now() - started } }
      )
    )
  }

  const queryMs = performance.now() - queryStarted
  return {
    modelId,
    dimensions,
    requestedRevision,
    revisionPinned: SHA_REVISION.test(requestedRevision),
    tokenizer: { modelId, requestedRevision },
    collection,
    collectionInfo: await qdrant.getCollection(collection),
    chunks: chunkCount,
    indexMs,
    queryMs,
    ...summarizeQueries(queries),
    queries
  }
}

const run = async (): Promise<void> => {
  const revisions = parseModelRevisions()
  const grid = MODELS.map(model => {
    const requestedRevision =
      revisions[model.id] ?? (model.id === env.embeddingModel ? env.embeddingRevision : undefined) ?? "main"
    return { ...model, requestedRevision, revisionPinned: SHA_REVISION.test(requestedRevision) }
  })
  const settings = {
    mode: "dense",
    searchLimit: SEARCH_LIMIT,
    depthPolicy: DEPTH_POLICY,
    searchHnswEf: env.searchHnswEf,
    chunkSize: env.chunkSize,
    chunkOverlap: env.chunkOverlap,
    baseline: BASELINE,
    modelRevisionsEnvironment: "EVAL_MODEL_REVISIONS",
    grid
  }
  const context = await createEvalRun("models", settings)
  await verifyQdrantConnection()
  await context.captureQdrant(getQdrantClient())

  const models = []
  for (const model of grid) {
    console.log(`Evaluating embedding model ${model.id} at ${model.requestedRevision}`)
    models.push(await evaluateModel(context, model.id, model.dimensions, model.requestedRevision))
  }
  const baseline = models[0]
  if (!baseline || baseline.modelId !== BASELINE) throw new Error(`Missing model baseline ${BASELINE}`)

  const results = {
    settings,
    documents: context.corpus.length,
    queries: context.dataset.length,
    models: models.map(model => ({
      ...model,
      comparisonToBaseline: compareQueries(baseline.queries, model.queries, context.bootstrapOptions)
    }))
  }
  const outPath = await context.writeResults(results)
  console.log(
    JSON.stringify(
      models.map(({ modelId, requestedRevision, metrics }) => ({ modelId, requestedRevision, metrics })),
      null,
      2
    )
  )
  console.log(`Wrote ${outPath}`)
}

if (import.meta.main) {
  run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

export { parseModelRevisions }
