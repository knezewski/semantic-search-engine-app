const assertSafeInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`)
}

/** Read an entire signed decimal integer, never a numeric prefix or coerced empty string. */
const readIntegerOption = (name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  assertSafeInteger("min", min)
  assertSafeInteger("max", max)
  if (min > max) throw new RangeError("min must not exceed max")
  const validate = (value: number): number => {
    assertSafeInteger(name, value)
    if (value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`)
    return value
  }
  validate(fallback)
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^[+-]?\d+$/.test(raw)) throw new TypeError(`${name} must be a decimal integer`)
  return validate(Number(raw))
}

/** Mulberry32: safe-integer seeds are normalized modulo 2^32; outputs are in [0, 1). */
const seededRandom = (seed: number): (() => number) => {
  assertSafeInteger("seed", seed)
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Zero means all; uncapped samples preserve order. Partial samples are shuffled copies. */
const sampleQueries = <T>(items: readonly T[], cap: number, seed: number): T[] => {
  assertSafeInteger("cap", cap)
  if (cap < 0) throw new RangeError("cap must be nonnegative")
  const random = seededRandom(seed)
  const sampled = [...items]
  if (cap === 0 || cap >= sampled.length) return sampled
  for (let index = sampled.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const value = sampled[index]
    sampled[index] = sampled[other]
    sampled[other] = value
  }
  return sampled.slice(0, cap)
}

export { readIntegerOption, sampleQueries, seededRandom }
