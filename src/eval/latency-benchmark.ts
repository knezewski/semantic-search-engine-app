import { summarize } from "../utils/percentile"

interface LatencySample {
  id: string
  pool: number
  repeat: number
  order: number
  candidates: number
  milliseconds: number
  stagesMs: Record<string, number>
}
interface LatencyOptions<T extends { id: string }> {
  items: readonly T[]
  pools: readonly number[]
  repeats: number
  warmupRounds: number
  seed: number
  run: (item: T, pool: number) => Promise<{ candidates: number; stagesMs?: Record<string, number> }>
  clock?: () => number
}
const integer = (value: number, minimum: number) => Number.isSafeInteger(value) && value >= minimum
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
const summary = (rows: LatencySample[]) => {
  const stages = [...new Set(rows.flatMap(row => Object.keys(row.stagesMs)))].sort()
  return {
    n: rows.length,
    ...summarize(rows.map(row => row.milliseconds)),
    stagesMs: Object.fromEntries(stages.map(stage => [stage, summarize(rows.map(row => row.stagesMs[stage]))]))
  }
}

/** Serial warm benchmark. Quantile spread describes observed repeats, NOT confidence intervals. */
const runLatencyBenchmark = async <T extends { id: string }>(options: LatencyOptions<T>) => {
  const { items, pools, repeats, warmupRounds, seed, run, clock = () => performance.now() } = options
  if (
    !items.length ||
    items.some(item => !item || typeof item.id !== "string" || !item.id.trim()) ||
    new Set(items.map(item => item.id)).size !== items.length
  )
    throw new Error("Latency items require nonempty unique IDs")
  if (!pools.length || pools.some(pool => !integer(pool, 1)) || new Set(pools).size !== pools.length)
    throw new Error("Latency pools require unique positive integers")
  if (!integer(repeats, 1) || !integer(warmupRounds, 0) || !integer(seed, 0) || seed > 0xffffffff)
    throw new Error("Invalid latency repeats, warmupRounds or seed")
  if (!Number.isSafeInteger((repeats + warmupRounds) * items.length * pools.length))
    throw new Error("Latency sample count overflows")
  const samples: LatencySample[] = []
  let stageKeys: string | undefined
  let previousClock = -Infinity
  const now = () => {
    const value = clock()
    if (!nonnegative(value) || value < previousClock) throw new Error("Latency clock must be finite and monotonic")
    previousClock = value
    return value
  }
  for (let round = 0; round < warmupRounds + repeats; round++) {
    // Rotate query order too, reducing systematic first/last-query effects across repeats.
    for (let queryOrder = 0; queryOrder < items.length; queryOrder++) {
      const itemIndex = (queryOrder + round + (seed % items.length)) % items.length
      const item = items[itemIndex]
      for (let order = 0; order < pools.length; order++) {
        const pool = pools[(order + itemIndex + round + (seed % pools.length)) % pools.length]
        const start = now()
        const result = await run(item, pool)
        const milliseconds = now() - start
        if (!result || !integer(result.candidates, 1) || result.candidates > pool)
          throw new Error(`Invalid candidate count for ${item.id}, pool ${pool}`)
        const stagesMs = result.stagesMs ?? {}
        if (
          typeof stagesMs !== "object" ||
          stagesMs === null ||
          Array.isArray(stagesMs) ||
          Object.entries(stagesMs).some(([key, value]) => !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) || !nonnegative(value))
        )
          throw new Error("Invalid latency stage sample")
        const keys = JSON.stringify(Object.keys(stagesMs).sort())
        if (stageKeys !== undefined && keys !== stageKeys)
          throw new Error("Latency stages must be consistent across samples")
        stageKeys = keys
        if (round >= warmupRounds)
          samples.push({
            id: item.id,
            pool,
            repeat: round - warmupRounds,
            order,
            candidates: result.candidates,
            milliseconds,
            stagesMs: { ...stagesMs }
          })
      }
    }
  }
  const summaries = pools.map(pool => {
    const rows = samples.filter(sample => sample.pool === pool)
    const perRepeat = Array.from({ length: repeats }, (_, repeat) => ({
      repeat,
      ...summary(rows.filter(row => row.repeat === repeat))
    }))
    const spread = (key: "p50" | "p95") => {
      const values = perRepeat.map(row => row[key])
      const min = Math.min(...values)
      const max = Math.max(...values)
      return { min, max, range: max - min }
    }
    return { pool, ...summary(rows), perRepeat, quantileSpread: { p50: spread("p50"), p95: spread("p95") } }
  })
  return {
    protocol:
      "serial concurrency=1; rotated query/pool order across rounds; full warmup rounds excluded; quantile spread descriptive, not CI",
    seed,
    repeats,
    warmupRounds,
    samples,
    summaries
  }
}
export type { LatencyOptions, LatencySample }
export { runLatencyBenchmark }
