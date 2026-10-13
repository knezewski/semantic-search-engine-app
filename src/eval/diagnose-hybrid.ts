import { tmpdir } from "node:os"
import { join } from "node:path"
import { env } from "../config/env"
import { splitDocument } from "../domain/chunk"
import { createDocumentRecord } from "../domain/document"
import { tokenize as projectTokenize } from "../domain/sparse"
import { HuggingFaceEmbeddingService } from "../services/embedding"
import { bm25Scores, buildTermIndex, rankTop, type TermIndex, tfIdfScores } from "./bm25"
import { aggregate, type QueryScore, recallAtK, scoreQuery } from "./metrics"
import type { EvalDocument, EvalQuery } from "./types"

/**
 * Explains why hybrid can score below dense. Everything runs in memory (no Qdrant writes):
 * it replicates the serving pipeline on chunk level (same chunker, model, TF-IDF sparse
 * channel and RRF), then swaps one component at a time.
 *
 * Usage: bun src/eval/diagnose-hybrid.ts <beirDir>
 */

const SEED = 42
const DEPTH = 100
const EMBED_BATCH = 32
const SAVE_EVERY_BATCHES = 10
const PROD_K = 60

interface ChunkRow {
  documentId: string
  text: string
}

interface Prepared {
  rows: ChunkRow[]
  vectors: number[][]
  terms: TermIndex
}

interface Channel {
  ids: number[]
  weight: number
}

type Ranker = (ranked: { dense: number[]; tfidf: number[]; bm25: number[] }) => number[]

const mulberry32 = (seed: number): (() => number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const sampleRandomDocuments = async (
  beirDir: string,
  excludeIds: Set<string>,
  count: number
): Promise<EvalDocument[]> => {
  const lines = (await Bun.file(join(beirDir, "corpus.jsonl")).text()).split("\n").filter(line => line.trim())
  const candidates = lines
    .map(line => JSON.parse(line) as { _id: string; title?: string; text: string })
    .filter(document => document.text.trim() !== "" && !excludeIds.has(`fiqa-${document._id}`))

  const random = mulberry32(SEED)
  for (let i = candidates.length - 1; i > candidates.length - 1 - count; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const a = candidates[i]
    const b = candidates[j]
    if (a && b) {
      candidates[i] = b
      candidates[j] = a
    }
  }
  return candidates.slice(-count).map(document => ({
    id: `fiqa-${document._id}`,
    title: document.title ?? "",
    text: document.text,
    source: `beir/fiqa/${document._id}`
  }))
}

const buildRows = async (documents: EvalDocument[]): Promise<ChunkRow[]> => {
  const rows: ChunkRow[] = []
  for (const item of documents) {
    const record = createDocumentRecord({ id: item.id, title: item.title, text: item.text, source: item.source })
    for (const chunk of await splitDocument(record)) {
      rows.push({ documentId: item.id, text: chunk.text })
    }
  }
  return rows
}

const loadEmbeddingCache = async (path: string): Promise<Map<string, number[]>> => {
  const file = Bun.file(path)
  if (!(await file.exists())) return new Map()
  return new Map(Object.entries((await file.json()) as Record<string, number[]>))
}

const embedMissing = async (
  texts: string[],
  embeddings: HuggingFaceEmbeddingService,
  cache: Map<string, number[]>,
  cachePath: string
): Promise<void> => {
  // Sorting by length keeps padding small inside each batch, which is much faster on CPU.
  const missing = [...new Set(texts)].filter(text => !cache.has(text)).sort((a, b) => a.length - b.length)
  console.log(`Embedding ${missing.length} new chunks (${cache.size} cached)`)
  for (let start = 0; start < missing.length; start += EMBED_BATCH) {
    const batch = missing.slice(start, start + EMBED_BATCH)
    const vectors = await embeddings.embedBatch(batch)
    batch.forEach((text, index) => {
      cache.set(text, vectors[index] ?? [])
    })
    const batchNumber = start / EMBED_BATCH
    if (batchNumber % SAVE_EVERY_BATCHES === 0) {
      console.log(`  ${Math.min(start + EMBED_BATCH, missing.length)}/${missing.length}`)
      await Bun.write(cachePath, JSON.stringify(Object.fromEntries(cache)))
    }
  }
  await Bun.write(cachePath, JSON.stringify(Object.fromEntries(cache)))
}

const dot = (a: number[], b: number[]): number => {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0)
  return sum
}

/** Weighted reciprocal-rank fusion; mirrors services/search/rrf.ts (stable order on ties). */
const fuse = (channels: Channel[], k: number): number[] => {
  const scores = new Map<number, number>()
  for (const channel of channels) {
    channel.ids.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + channel.weight / (k + rank + 1))
    })
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

const hybrid =
  (sparse: "tfidf" | "bm25", pool: number, denseWeight = 1, k = PROD_K): Ranker =>
  ranked =>
    fuse(
      [
        { ids: ranked.dense.slice(0, pool), weight: denseWeight },
        { ids: ranked[sparse].slice(0, pool), weight: 1 }
      ],
      k
    )

const CONFIGS: Array<{ name: string; rank: Ranker }> = [
  { name: "dense only", rank: r => r.dense },
  { name: "sparse TF-IDF only (what Qdrant does today)", rank: r => r.tfidf },
  { name: "sparse BM25 only (reference)", rank: r => r.bm25 },
  { name: "hybrid PROD: TF-IDF, pool 15, k60, 1:1", rank: hybrid("tfidf", 15) },
  { name: "hybrid: BM25 instead of TF-IDF", rank: hybrid("bm25", 15) },
  { name: "hybrid: TF-IDF, pool 50", rank: hybrid("tfidf", 50) },
  { name: "hybrid: BM25, pool 50", rank: hybrid("bm25", 50) },
  { name: "hybrid: TF-IDF, pool 15, dense x2", rank: hybrid("tfidf", 15, 2) },
  { name: "hybrid: TF-IDF, pool 15, dense x3", rank: hybrid("tfidf", 15, 3) },
  { name: "hybrid: BM25, pool 50, dense x2", rank: hybrid("bm25", 50, 2) }
]

const prepare = async (documents: EvalDocument[], cache: Map<string, number[]>): Promise<Prepared> => {
  const rows = await buildRows(documents)
  return {
    rows,
    vectors: rows.map(row => cache.get(row.text) ?? []),
    terms: buildTermIndex(
      rows.map(row => row.text),
      projectTokenize
    )
  }
}

const toDocumentIds = (prepared: Prepared, chunkIds: number[]): string[] =>
  chunkIds.map(id => prepared.rows[id]?.documentId ?? "")

const evaluateCorpus = (
  prepared: Prepared,
  dataset: EvalQuery[],
  queryVectors: number[][]
): { scores: Map<string, QueryScore>; coverage: Record<string, number> } => {
  const perConfig = new Map<string, QueryScore[]>(CONFIGS.map(config => [config.name, []]))
  const coverage: Record<string, number[]> = {
    dense15: [],
    tfidf15: [],
    union15: [],
    dense50: [],
    bm25_50: [],
    union50: []
  }

  dataset.forEach((item, queryIndex) => {
    const queryVector = queryVectors[queryIndex] ?? []
    const queryTokens = projectTokenize(item.query)

    const denseScores = prepared.vectors.map(vector => dot(vector, queryVector))
    const ranked = {
      dense: rankTop(denseScores, DEPTH, Number.NEGATIVE_INFINITY),
      tfidf: rankTop(tfIdfScores(prepared.terms, queryTokens), DEPTH),
      bm25: rankTop(bm25Scores(prepared.terms, queryTokens), DEPTH)
    }

    for (const config of CONFIGS) {
      const top = toDocumentIds(prepared, config.rank(ranked).slice(0, 10))
      perConfig.get(config.name)?.push(scoreQuery(top, item.relevantDocumentIds))
    }

    const covers = (ids: number[]): number =>
      recallAtK(toDocumentIds(prepared, ids), item.relevantDocumentIds, Number.MAX_SAFE_INTEGER)
    coverage.dense15?.push(covers(ranked.dense.slice(0, 15)))
    coverage.tfidf15?.push(covers(ranked.tfidf.slice(0, 15)))
    coverage.union15?.push(covers([...ranked.dense.slice(0, 15), ...ranked.tfidf.slice(0, 15)]))
    coverage.dense50?.push(covers(ranked.dense.slice(0, 50)))
    coverage.bm25_50?.push(covers(ranked.bm25.slice(0, 50)))
    coverage.union50?.push(covers([...ranked.dense.slice(0, 50), ...ranked.bm25.slice(0, 50)]))
  })

  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)
  return {
    scores: new Map([...perConfig].map(([name, scores]) => [name, aggregate(scores)])),
    coverage: Object.fromEntries(Object.entries(coverage).map(([name, values]) => [name, mean(values)]))
  }
}

const fmt = (value: number): string => value.toFixed(3).padStart(6)

const printTable = (title: string, result: ReturnType<typeof evaluateCorpus>): void => {
  console.log(`\n=== ${title} ===`)
  console.log(
    `${"config".padEnd(46)}${"Hit@1".padStart(7)}${"Hit@10".padStart(7)}${"Rec@10".padStart(7)}${"MRR".padStart(7)}${"NDCG10".padStart(7)}`
  )
  for (const [name, s] of result.scores) {
    console.log(
      `${name.padEnd(46)} ${fmt(s.hitAt1)} ${fmt(s.hitAt10)} ${fmt(s.recallAt10)} ${fmt(s.mrr)} ${fmt(s.ndcgAt10)}`
    )
  }
  const c = result.coverage
  console.log(
    `gold-doc coverage of candidate pool: dense@15=${fmt(c.dense15 ?? 0)} tfidf@15=${fmt(c.tfidf15 ?? 0)} union@15=${fmt(c.union15 ?? 0)} | dense@50=${fmt(c.dense50 ?? 0)} bm25@50=${fmt(c.bm25_50 ?? 0)} union@50=${fmt(c.union50 ?? 0)}`
  )
}

const run = async (): Promise<void> => {
  const [beirDir] = Bun.argv.slice(2)
  if (!beirDir) throw new Error("Usage: bun src/eval/diagnose-hybrid.ts <beirDir>")

  const fixtureDir = join(import.meta.dir, "fixtures", "fiqa-hn")
  const corpus = (await Bun.file(join(fixtureDir, "corpus.json")).json()) as EvalDocument[]
  const dataset = (await Bun.file(join(fixtureDir, "dataset.json")).json()) as EvalQuery[]

  const goldIds = new Set(dataset.flatMap(item => item.relevantDocumentIds))
  const goldDocuments = corpus.filter(document => goldIds.has(document.id))
  const randomDocuments = await sampleRandomDocuments(beirDir, goldIds, corpus.length - goldDocuments.length)
  const corpora = [
    { name: "fixture: BM25-mined hard negatives (as in eval)", documents: corpus },
    { name: "control: same gold + random negatives", documents: [...goldDocuments, ...randomDocuments] }
  ]
  console.log(
    `gold=${goldDocuments.length} negatives per corpus=${corpus.length - goldDocuments.length} queries=${dataset.length}`
  )

  const embeddings = new HuggingFaceEmbeddingService(env.embeddingModel, env.vectorSize)
  const cachePath = join(tmpdir(), "diagnose-hybrid-embeddings.json")
  const cache = await loadEmbeddingCache(cachePath)

  const allRows = await Promise.all(corpora.map(item => buildRows(item.documents)))
  await embedMissing(
    [...allRows.flatMap(rows => rows.map(row => row.text)), ...dataset.map(item => item.query)],
    embeddings,
    cache,
    cachePath
  )
  const queryVectors = dataset.map(item => cache.get(item.query) ?? [])

  for (const item of corpora) {
    const prepared = await prepare(item.documents, cache)
    printTable(item.name, evaluateCorpus(prepared, dataset, queryVectors))
  }

  const prod = (await Bun.file(join(import.meta.dir, "../../eval-results-fiqa-hn.json")).json()) as {
    metrics: Record<string, Record<string, number>>
  }
  const pick = (m: Record<string, number> | undefined): string =>
    [m?.hitAt1, m?.hitAt10, m?.recallAt10, m?.mrr, m?.ndcgAt10].map(value => fmt(value ?? 0)).join(" ")
  console.log("\n=== validation: real pipeline (Qdrant), fixture corpus ===")
  console.log(`${"dense".padEnd(46)} ${pick(prod.metrics.dense)}`)
  console.log(`${"hybrid".padEnd(46)} ${pick(prod.metrics.hybrid)}`)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
