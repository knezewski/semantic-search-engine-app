const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  if (low === high) return sorted[low] ?? 0
  const weight = rank - low
  return (sorted[low] ?? 0) * (1 - weight) + (sorted[high] ?? 0) * weight
}

const summarize = (values: number[]) => ({
  count: values.length,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  p99: percentile(values, 99),
  max: values.length === 0 ? 0 : Math.max(...values)
})

export { percentile, summarize }
