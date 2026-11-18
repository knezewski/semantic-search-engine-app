import { expect, test } from "bun:test"
import { runLatencyBenchmark } from "./latency-benchmark"

const items = [{ id: "a" }, { id: "b" }]
const base = { items, pools: [15, 30, 50], repeats: 3, warmupRounds: 1, seed: 42 }
test("runs serially, excludes all warmups, rotates every query/pool position and retains raw stages", async () => {
  let time = 0
  let active = false
  let calls = 0
  const result = await runLatencyBenchmark({
    ...base,
    clock: () => time,
    run: async (_item, pool) => {
      expect(active).toBe(false)
      active = true
      await Promise.resolve()
      time += calls++ < 6 ? 10000 : pool
      active = false
      return { candidates: pool, stagesMs: { rerank: pool - 1, endToEnd: pool } }
    }
  })
  expect(calls).toBe(24)
  expect(result.samples).toHaveLength(18)
  expect(result.samples.every(sample => sample.milliseconds === sample.pool)).toBe(true)
  for (const item of items)
    for (const pool of base.pools) {
      const samples = result.samples.filter(row => row.id === item.id && row.pool === pool)
      expect(samples.map(row => row.repeat)).toEqual([0, 1, 2])
      expect(new Set(samples.map(row => row.order)).size).toBe(3)
    }
  for (const summary of result.summaries) {
    expect(summary.n).toBe(6)
    expect(summary.p50).toBe(summary.pool)
    expect(summary.p95).toBe(summary.pool)
    expect(summary.perRepeat.map(row => row.n)).toEqual([2, 2, 2])
    expect(summary.quantileSpread.p95).toEqual({ min: summary.pool, max: summary.pool, range: 0 })
    expect(summary.stagesMs.rerank.p95).toBe(summary.pool - 1)
  }
  expect(result.protocol).toContain("not CI")
})
test("repeat quantile spread describes actual repeat variation", async () => {
  let time = 0
  let calls = 0
  const result = await runLatencyBenchmark({
    ...base,
    items: [items[0]],
    pools: [1],
    warmupRounds: 0,
    clock: () => time,
    run: async () => {
      time += ++calls
      return { candidates: 1 }
    }
  })
  expect(result.summaries[0].quantileSpread.p50).toEqual({ min: 1, max: 3, range: 2 })
  expect(result.summaries[0].p50).toBe(2)
})
test("deterministic seeded order; no mutation of input arrays", async () => {
  const run = async (seed: number) =>
    (await runLatencyBenchmark({ ...base, seed, clock: () => 0, run: async (_q, pool) => ({ candidates: pool }) }))
      .samples
  expect(await run(1)).toEqual(await run(1))
  expect(await run(1)).not.toEqual(await run(2))
  expect(items.map(item => item.id)).toEqual(["a", "b"])
  expect(base.pools).toEqual([15, 30, 50])
})
test("rejects malformed inputs before invoking callback", async () => {
  let calls = 0
  const run = async () => {
    calls++
    return { candidates: 1 }
  }
  for (const overrides of [
    { items: [] },
    { items: [{ id: " " }] },
    { items: [items[0], items[0]] },
    { pools: [] },
    { pools: [1, 1] },
    { pools: [0] },
    { pools: [Infinity] },
    { repeats: 0 },
    { repeats: 1.5 },
    { warmupRounds: -1 },
    { seed: NaN },
    { seed: 0x100000000 }
  ]) {
    await expect(runLatencyBenchmark({ ...base, ...overrides, run })).rejects.toThrow()
  }
  expect(calls).toBe(0)
})
test("rejects empty, excessive or nonfinite candidate counts and stages including warmups", async () => {
  for (const candidates of [0, -1, 100, 1.5, Infinity, NaN])
    await expect(runLatencyBenchmark({ ...base, run: async () => ({ candidates }) })).rejects.toThrow("candidate")
  for (const stagesMs of [{ rerank: NaN }, { rerank: Infinity }, { rerank: -1 }])
    await expect(runLatencyBenchmark({ ...base, run: async () => ({ candidates: 1, stagesMs }) })).rejects.toThrow(
      "stage"
    )
  let calls = 0
  await expect(
    runLatencyBenchmark({
      ...base,
      run: async () => ({ candidates: 1, stagesMs: Object.fromEntries([[++calls === 1 ? "a" : "b", 1]]) })
    })
  ).rejects.toThrow("consistent")
})
test("rejects invalid/nonmonotonic clocks and propagates callback failures", async () => {
  for (const value of [NaN, Infinity, -1])
    await expect(
      runLatencyBenchmark({ ...base, clock: () => value, run: async () => ({ candidates: 1 }) })
    ).rejects.toThrow("clock")
  let time = 2
  await expect(
    runLatencyBenchmark({ ...base, clock: () => time--, run: async () => ({ candidates: 1 }) })
  ).rejects.toThrow("clock")
  await expect(
    runLatencyBenchmark({
      ...base,
      run: async () => {
        throw new Error("candidate retrieval failed")
      }
    })
  ).rejects.toThrow("candidate retrieval failed")
})
