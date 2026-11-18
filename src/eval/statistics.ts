import type { QueryScore } from "./metrics"
import { seededRandom } from "./sampling"

interface BootstrapOptions {
  seed?: number
  resamples?: number
  confidence?: number
}

interface BootstrapResult {
  delta: number
  lower: number
  upper: number
  confidence: number
  resamples: number
  seed: number
  n: number
}

type ScoreComparison = { [Metric in keyof QueryScore]: BootstrapResult }

/** Linear interpolation between adjacent sorted observations (R-7 percentile). */
const percentile = (sorted: readonly number[], probability: number): number => {
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const fraction = position - lower
  const left = sorted[lower]
  const right = sorted[Math.ceil(position)]
  return (1 - fraction) * left + fraction * right
}

/** Paired percentile bootstrap of the mean variant-minus-baseline difference. */
const pairedBootstrap = (
  baseline: readonly number[],
  variant: readonly number[],
  options: BootstrapOptions = {}
): BootstrapResult => {
  if (baseline.length === 0 || baseline.length !== variant.length) {
    throw new RangeError("baseline and variant must have the same nonzero length")
  }
  const { seed = 42, resamples = 10_000, confidence = 0.95 } = options
  const random = seededRandom(seed)
  if (!Number.isSafeInteger(resamples) || resamples < 1) {
    throw new RangeError("resamples must be a positive safe integer")
  }
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new RangeError("confidence must be finite and strictly between zero and one")
  }

  const n = baseline.length
  const differences: number[] = []
  for (let index = 0; index < n; index++) {
    const before = baseline[index]
    const after = variant[index]
    if (!Number.isFinite(before) || !Number.isFinite(after)) {
      throw new TypeError("all paired observations must be finite numbers")
    }
    const difference = after - before
    if (!Number.isFinite(difference)) {
      throw new RangeError("paired differences must be representable as finite numbers")
    }
    differences.push(difference)
  }

  // Divide before summing to avoid overflow for large, finite observations.
  const delta = differences.reduce((sum, difference) => sum + difference / n, 0)
  const estimates: number[] = []
  for (let iteration = 0; iteration < resamples; iteration++) {
    let estimate = 0
    for (let draw = 0; draw < n; draw++) {
      estimate += differences[Math.floor(random() * n)] / n
    }
    estimates.push(estimate)
  }
  estimates.sort((left, right) => left - right)
  const tail = (1 - confidence) / 2
  return {
    delta,
    lower: percentile(estimates, tail),
    upper: percentile(estimates, 1 - tail),
    confidence,
    resamples,
    seed,
    n
  }
}

/** Rows must already be paired in identical query order. Each metric uses the same seed. */
const compareScores = (
  baseline: readonly QueryScore[],
  variant: readonly QueryScore[],
  options: BootstrapOptions = {}
): ScoreComparison => {
  const compare = (metric: keyof QueryScore): BootstrapResult =>
    pairedBootstrap(
      baseline.map(score => score[metric]),
      variant.map(score => score[metric]),
      options
    )
  return {
    hitAt1: compare("hitAt1"),
    hitAt5: compare("hitAt5"),
    hitAt10: compare("hitAt10"),
    recallAt1: compare("recallAt1"),
    recallAt5: compare("recallAt5"),
    recallAt10: compare("recallAt10"),
    mrrAt10: compare("mrrAt10"),
    ndcgAt10: compare("ndcgAt10")
  }
}

export type { BootstrapOptions, BootstrapResult, ScoreComparison }
export { compareScores, pairedBootstrap }
