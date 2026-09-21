import { join } from "node:path"
import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import type { EvalQuery } from "../eval/types"
import { warmupEmbeddings } from "../services/embedding"
import { SearchService } from "../services/search"
import { summarize } from "../utils/percentile"

const WARMUP_ROUNDS = 3
const MEASURE_ROUNDS = 8

const loadQueries = async (): Promise<string[]> => {
  const path = join(import.meta.dir, "../eval/fixtures/dataset.json")
  const dataset = (await Bun.file(path).json()) as EvalQuery[]
  return dataset.map(item => item.query)
}

const run = async (): Promise<void> => {
  await verifyQdrantConnection()
  await warmupEmbeddings()

  const search = new SearchService(getQdrantClient())
  const queries = await loadQueries()

  for (let round = 0; round < WARMUP_ROUNDS; round += 1) {
    await search.searchTimed({ query: queries[round % queries.length] ?? "warmup", limit: 5 })
  }

  const embedMs: number[] = []
  const qdrantMs: number[] = []
  const totalMs: number[] = []

  for (let round = 0; round < MEASURE_ROUNDS; round += 1) {
    for (const query of queries) {
      const timed = await search.searchTimed({ query, limit: 5 })
      embedMs.push(timed.embedMs)
      qdrantMs.push(timed.qdrantMs)
      totalMs.push(timed.totalMs)
    }
  }

  const round = (value: number) => Number(value.toFixed(2))
  const results = {
    samples: totalMs.length,
    warmupRounds: WARMUP_ROUNDS,
    measureRounds: MEASURE_ROUNDS,
    totalMs: {
      p50: round(summarize(totalMs).p50),
      p95: round(summarize(totalMs).p95),
      p99: round(summarize(totalMs).p99),
      max: round(summarize(totalMs).max)
    },
    embedMs: {
      p50: round(summarize(embedMs).p50),
      p95: round(summarize(embedMs).p95)
    },
    qdrantMs: {
      p50: round(summarize(qdrantMs).p50),
      p95: round(summarize(qdrantMs).p95)
    }
  }

  const outPath = join(import.meta.dir, "../../bench-results.json")
  await Bun.write(outPath, `${JSON.stringify(results, null, 2)}\n`)
  console.log(JSON.stringify(results, null, 2))
  console.log(`Wrote ${outPath}`)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
