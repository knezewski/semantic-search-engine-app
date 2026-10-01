type CircuitState = "closed" | "open" | "half-open"

interface CircuitBreakerOptions {
  /** Consecutive failures before the breaker opens. */
  threshold?: number
  /** How long the breaker stays open before allowing a single probe. */
  cooldownMs?: number
}

/**
 * A minimal circuit breaker for guarding external dependencies (e.g. Qdrant).
 * After `threshold` consecutive failures it opens and fails fast for
 * `cooldownMs`, then lets one request through in "half-open" state to probe
 * recovery. Success closes the circuit again.
 */
class CircuitBreaker {
  private state: CircuitState = "closed"
  private failures = 0
  private openedAt = 0
  private readonly threshold: number
  private readonly cooldownMs: number

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5
    this.cooldownMs = options.cooldownMs ?? 30_000
  }

  get isOpen(): boolean {
    return this.state === "open"
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.openedAt < this.cooldownMs) {
        throw new CircuitOpenError()
      }
      this.state = "half-open"
    }

    try {
      const result = await action()
      this.reset()
      return result
    } catch (error) {
      this.recordFailure()
      throw error
    }
  }

  private recordFailure(): void {
    this.failures += 1
    if (this.failures >= this.threshold) {
      this.state = "open"
      this.openedAt = Date.now()
    }
  }

  private reset(): void {
    this.state = "closed"
    this.failures = 0
  }
}

class CircuitOpenError extends Error {
  constructor() {
    super("Circuit breaker is open")
    this.name = "CircuitOpenError"
  }
}

export { CircuitBreaker, CircuitOpenError }
