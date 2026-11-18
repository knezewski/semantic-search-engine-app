import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { getEmbeddingService } from "../services/embedding"
import { getRerankService } from "../services/rerank"
import { VectorService } from "../services/vector"
import { indexCorpus, payloadString } from "./helpers"
import { runLatencyBenchmark } from "./latency-benchmark"
import { measurePoolPath, parsePoolProtocol, type PoolPorts, preparePoolQuery } from "./pool-protocol"
import { compareQueries, summarizeQueries } from "./report"
import { createEvalRun } from "./run-context"
import { captureRuntimeMetadata } from "./runtime-metadata"
import { readIntegerOption, sampleQueries } from "./sampling"

const SEARCH_LIMIT = 10
const POOLS = [15, 30, 50] as const
const SCHEMA_VERSION = "rerank-pool-v3-independent"

const run = async (): Promise<void> => {
  const generalCap = readIntegerOption("EVAL_QUERIES", 0)
  const queryCap = readIntegerOption("EVAL_RERANK_QUERIES", generalCap)
  if (
    process.env.EVAL_QUERIES !== undefined &&
    process.env.EVAL_RERANK_QUERIES !== undefined &&
    generalCap !== queryCap
  )
    throw new Error("EVAL_QUERIES and legacy EVAL_RERANK_QUERIES disagree")
  const protocol = parsePoolProtocol(process.env.EVAL_POOL_PROTOCOL)
  const latencySampleSize = readIntegerOption("EVAL_LATENCY_QUERIES", 100, 1)
  const repeats = readIntegerOption("EVAL_LATENCY_REPEATS", 3, 1)
  const warmupRounds = readIntegerOption("EVAL_LATENCY_WARMUP_ROUNDS", 1, 1)
  const context = await createEvalRun(
    "rerank-pool",
    {
      schemaVersion: SCHEMA_VERSION,
      searchLimit: SEARCH_LIMIT,
      pools: POOLS,
      maxPool: 50,
      poolProtocol: protocol,
      qualityProtocol: "independent score call for each pool; no top-50 logit reuse",
      retrievalProtocol:
        protocol === "fixed-candidates"
          ? "retrieve 50 once per quality query and independently score each prefix; dense baseline is top 10 of same retrieval"
          : "retrieve each pool with its own limit; separate limit-10 dense baseline; vector retrieval-depth reproduction, NOT complete SearchService",
      latencySampleSize,
      latencyRepeats: repeats,
      latencyWarmupRounds: warmupRounds,
      latencyProtocol:
        "serial repeated warm embedding-service + vector retrieval + independent rerank; embedding service cache may be hit; NOT complete SearchService or cold-start/SLA"
    },
    { queryCap }
  )
  const collection = context.collection()
  await verifyQdrantConnection()
  const qdrant = getQdrantClient()
  await context.captureQdrant(qdrant)
  const vectors = new VectorService(qdrant, collection)
  await indexCorpus(context.corpus, vectors, collection)
  const embeddings = getEmbeddingService()
  const rerank = getRerankService()
  const ports: PoolPorts = {
    embed: query => embeddings.embed(query),
    search: async (vector, limit) =>
      (await vectors.searchChunks({ vector, limit })).map(point => ({
        documentId: payloadString(point.payload, "documentId"),
        chunkId: payloadString(point.payload, "chunkId") || String(point.id),
        text: payloadString(point.payload, "text"),
        score: point.score
      })),
    score: (query, passages) => rerank.score(query, passages)
  }
  const prepared: Array<Awaited<ReturnType<typeof preparePoolQuery>>> = []
  for (const [index, item] of context.dataset.entries()) {
    prepared.push(await preparePoolQuery(item, ports, protocol, POOLS, SEARCH_LIMIT))
    console.log(`Quality ${index + 1}/${context.dataset.length}: ${item.id}`)
  }
  const baselineRows = prepared.map(query => query.baseline)
  const quality = POOLS.map(pool => {
    const variants = prepared.map(query => {
      const variant = query.variants.find(candidate => candidate.pool === pool)
      if (!variant) throw new Error(`Missing pool ${pool}`)
      return variant
    })
    const queryResults = variants.map(variant => variant.queryResult)
    return {
      pool,
      ...summarizeQueries(queryResults),
      comparisonToDense: compareQueries(baselineRows, queryResults, context.bootstrapOptions),
      queryResults,
      candidateScores: prepared.map((query, index) => ({ id: query.id, candidates: variants[index].candidateScores }))
    }
  })
  const latencySample = sampleQueries(prepared, latencySampleSize, (context.seed + 1) >>> 0)
  const latencyEnvironmentInitial = captureRuntimeMetadata()
  const latency = await runLatencyBenchmark({
    items: latencySample,
    pools: [...POOLS],
    repeats,
    warmupRounds,
    seed: context.seed,
    run: (query, pool) => measurePoolPath(query.item, pool, ports, protocol)
  })
  const latencyEnvironmentFinal = captureRuntimeMetadata()
  const pools = quality.map(variant => {
    const samples = latency.samples.filter(sample => sample.pool === variant.pool)
    const summary = latency.summaries.find(summary => summary.pool === variant.pool)
    if (!summary) throw new Error(`Missing latency summary for pool ${variant.pool}`)
    return {
      ...variant,
      comparisonToPool15: compareQueries(quality[0].queryResults, variant.queryResults, context.bootstrapOptions),
      latencyMs: { ...summary, samples }
    }
  })
  const path = await context.writeResults({
    schemaVersion: SCHEMA_VERSION,
    legacyValidatorCompatible: false,
    poolProtocol: protocol,
    collection,
    collectionInfo: await vectors.getCollection(collection),
    documents: context.corpus.length,
    queries: context.dataset.length,
    validForQualityComparison: true,
    denseBaseline: {
      ...summarizeQueries(baselineRows),
      queryResults: baselineRows,
      candidateScores: prepared.map(query => ({ id: query.id, candidates: query.baselineCandidates }))
    },
    latencyQueryIds: latencySample.map(query => query.id),
    latencyWarning:
      latencySample.length < 100
        ? "Fewer than 100 unique latency queries; repeats do not increase independent sample size."
        : null,
    latency,
    latencyEnvironment: { initial: latencyEnvironmentInitial, final: latencyEnvironmentFinal },
    pools
  })
  console.log(
    JSON.stringify(
      pools.map(({ pool, metrics, latencyMs }) => ({
        pool,
        metrics,
        latencyMs: { n: latencyMs.n, p50: latencyMs.p50, p95: latencyMs.p95 }
      })),
      null,
      2
    )
  )
  console.log(`Wrote ${path}`)
}

if (import.meta.main)
  run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
