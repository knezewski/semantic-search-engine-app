/**
 * Rejects with `message` if `promise` does not settle within `ms`.
 * Used to bound operations that would otherwise hang on a dead dependency
 * (e.g. a BullMQ `queue.add()` buffered while Redis is unreachable).
 */
const withTimeout = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })

  // Swallow a late rejection from the losing promise so it cannot crash the process.
  promise.catch(() => undefined)

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export { withTimeout }
