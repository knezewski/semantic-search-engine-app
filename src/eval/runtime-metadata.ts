import { readFileSync } from "node:fs"
import { availableParallelism, cpus, loadavg, totalmem } from "node:os"

const THREAD_HINTS = [
  "OMP_NUM_THREADS",
  "OMP_THREAD_LIMIT",
  "MKL_NUM_THREADS",
  "OPENBLAS_NUM_THREADS",
  "VECLIB_MAXIMUM_THREADS",
  "ORT_NUM_THREADS",
  "UV_THREADPOOL_SIZE"
] as const
/** Values are typed/redacted: even allowlisted keys cannot smuggle arbitrary secret strings. */
const inferenceEnvironmentHints = (environment: Record<string, string | undefined>) =>
  Object.fromEntries(
    THREAD_HINTS.map(key => {
      const raw = environment[key]
      return [
        key,
        raw === undefined ? null : /^\d{1,8}$/.test(raw) && Number(raw) > 0 ? Number(raw) : "invalid-or-redacted"
      ]
    })
  )

const parseProcessLimits = (text: string) => {
  const names = ["Max open files", "Max processes", "Max address space"]
  return Object.fromEntries(
    names.map(name => {
      const line = text.split("\n").find(row => row.startsWith(`${name} `))
      const fields = line?.slice(name.length).trim().split(/\s+/) ?? []
      const safe = (value: string | undefined) =>
        value === "unlimited"
          ? value
          : value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
            ? Number(value)
            : null
      return [name, { soft: safe(fields[0]), hard: safe(fields[1]) }]
    })
  )
}
const captureRuntimeMetadata = () => {
  let processLimits: ReturnType<typeof parseProcessLimits> | null = null
  try {
    processLimits = parseProcessLimits(readFileSync("/proc/self/limits", "utf8"))
  } catch {
    /* Unavailable on non-Linux hosts. */
  }
  return {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    hardware: {
      cpuModel: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length,
      availableParallelism: availableParallelism(),
      totalMemoryBytes: totalmem()
    },
    process: {
      memoryUsageBytes: process.memoryUsage(),
      cpuUsageMicroseconds: process.cpuUsage(),
      limits: processLimits,
      limitsSource: processLimits
        ? "/proc/self/limits (allowlisted numeric limits only)"
        : "unavailable; not inferred from host RAM"
    },
    hostLoadAverage: {
      values: loadavg(),
      note: "Host load averages; not process CPU utilization or proof of an idle host; may be unsupported on this platform."
    },
    inference: {
      declarationsSource: "Current service call parameters, not introspected inference sessions",
      actualSession: {
        backend: null,
        device: null,
        dtype: null,
        threads: null,
        note: "Not introspected; auto selection and environment hints are not evidence of actual runtime settings."
      },
      embedding: {
        dtype: null,
        device: null,
        batchSize: null,
        batchPolicy: "all texts supplied to embedBatch; embed uses one text",
        padding: null,
        truncation: null,
        maxLength: null,
        pooling: "mean",
        normalize: true,
        threadSettings: null,
        note: "dtype/device/tokenization/session options are not explicitly supplied by the embedding service"
      },
      reranker: {
        dtype: "q8",
        device: null,
        batchSize: null,
        batchPolicy: "all passages in one score call",
        padding: true,
        truncation: true,
        maxLength: null,
        threadSettings: null
      },
      environmentHints: inferenceEnvironmentHints(process.env),
      environmentHintsNote:
        "Allowlisted declared thread hints only; application/backend support and effective values are unverified. No arbitrary raw environment values are persisted."
    }
  }
}
type RuntimeMetadata = ReturnType<typeof captureRuntimeMetadata>
export type { RuntimeMetadata }
export { captureRuntimeMetadata, inferenceEnvironmentHints, parseProcessLimits }
