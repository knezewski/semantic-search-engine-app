# Semantic Document Retrieval Engine

Production-shaped backend for semantic document search: HTTP ingest → BullMQ workers → Qdrant → hybrid retrieval with cross-encoder reranking. Built in TypeScript on Bun, with evaluation and latency harnesses baked in from day one.

**Why it exists:** retrieval quality is only as good as what you measure. This repo pairs a hybrid search pipeline with a reproducible eval loop (Recall@K / MRR / NDCG) and per-request latency breakdowns, so retrieval changes are judged on numbers, not vibes.

```
Client → Hono API → Service → BullMQ (Redis) → Ingest → Chunk → Embed → Index → Qdrant → POST /search
```

## Features

- **Hybrid retrieval:** dense + BM25 sparse, fused with Reciprocal Rank Fusion (RRF).
- **Reranking:** optional cross-encoder rerank over the hybrid candidate pool (opt-in via `RERANK_ENABLED`).
- **Measured quality:** Recall@K / MRR / NDCG harness over BEIR FiQA (with hard negatives) plus chunk-size, embedding-model, RRF, rerank-pool, and Qdrant quantization sweeps.
- **Latency transparency:** `Server-Timing` response header splitting `embed` / `qdrant` / `rerank` / `total`; search-percentile and ingest-throughput benchmarks.
- **Resilient ingest:** four BullMQ queues + workers, 3 attempts with exponential backoff, manual replay, deterministic chunk ids, idempotent `document_chunks` collection with payload indexes.
- **Operable:** `/health`, `/ready`, `/metrics`; circuit breaker and graceful shutdown; typed env; SQLite document store.

## Evaluation status

The harness uses **`document-v2` metrics**: document IDs are deduplicated in first-occurrence order before every cutoff, NDCG cannot count the same document twice, and reciprocal rank is explicitly named **MRR@10**. Each run saves a configuration/data manifest, raw per-query rankings, slices and seeded paired-bootstrap differences in a unique `eval-runs/<run-id>/` directory.

### Latest retrieval snapshot

The latest completed v3 benchmark was run on **2026-11-17**, using 648 queries over 3,393 documents and pinned embedding/reranker revisions. It evaluates a **ranked document list**, not generated answers:

| Configuration | Recall@10 | MRR@10 | NDCG@10 |
| --- | ---: | ---: | ---: |
| Dense baseline | 0.6422 | 0.6295 | 0.5581 |
| Dense + reranker, pool=15 | 0.6428 | 0.5754 | 0.5256 |
| Dense + reranker, pool=30 | 0.6283 | 0.5657 | 0.5125 |
| Dense + reranker, pool=50 | 0.6171 | 0.5561 | 0.5015 |

Relative to dense, pool=15 changed NDCG@10 by **−0.0325** (95% paired bootstrap CI **[−0.0482, −0.0170]**). The reranker did not provide a quality gain on this benchmark. The current recommendation is therefore **dense-first; keep reranking opt-in**.

These are retrieval results for a reduced FiQA stress fixture containing gold documents and BM25-mined distractors. The queries influenced tuning, so this is **not an independent held-out test, a production estimate, or a business SLA**. Older metric-v1 artifacts are not comparable. The benchmark used the independent v3 pool protocol; the old top-50-logit-reuse protocol is obsolete.

- Built-in `smoke`: **12 documents / 8 queries**, for wiring checks only.
- `fiqa-hn`: **3,393 documents / 648 queries**, a reduced-corpus stress benchmark.
- Dense-first defaults remain unchanged; reranking is not enabled by default.
- The result does not establish quality on your future production queries. For release decisions, add a genuinely unused, domain-specific judged query set and agree on a top-K success threshold and latency target before tuning against it.

See the [latest detailed v3 report](<eval-runs/audit-v3-20261117T150656Z-nlLoLZ/report-v3.md>) and [evaluation methodology](<docs/evaluation.md>).

```bash
# Explicit local endpoint: these commands index fresh collections and may download models.
QDRANT_URL=http://localhost:6333 QDRANT_API_KEY= EVAL_FIXTURE_SET=fiqa-hn bun run eval
QDRANT_URL=http://localhost:6333 QDRANT_API_KEY= EVAL_FIXTURE_SET=fiqa-hn bun run eval:rrf
QDRANT_URL=http://localhost:6333 QDRANT_API_KEY= EVAL_FIXTURE_SET=fiqa-hn EVAL_QUERIES=200 EVAL_SEED=42 EVAL_POOL_PROTOCOL=fixed-candidates bun run eval:rerank-pool
```

`eval:rerank-pool` uses independent reranker calls per pool. Set `EVAL_POOL_PROTOCOL=serving-depth` to retrieve each pool at its own depth. Repeated warm latency defaults are controlled by `EVAL_LATENCY_REPEATS=3` and `EVAL_LATENCY_WARMUP_ROUNDS=1`; these measurements are exploratory and are not an end-to-end SLA.

See [evaluation methodology and artifact schema](<docs/evaluation.md>) for metric semantics, model pinning, latency protocol, limitations and the rerun checklist.

## Tech

Bun · Hono · TypeScript · Qdrant · Redis · BullMQ · SQLite · Hugging Face / Xenova embeddings + cross-encoder.

## Prerequisites

- [Bun](https://bun.sh)
- Docker (Redis + Qdrant)

## Run locally

```
cp .env.example .env
bun install
bun run infra:up
bun run dev          # API
bun run dev:worker   # second terminal
```

- API: `http://localhost:3000`
- Qdrant dashboard: `http://localhost:6333/dashboard`
- Redis: `localhost:6379`

On start the API verifies Qdrant, calls `VectorService.ensureCollection()`, and warms up the embedding (and rerank) models. If the API runs _inside_ Compose, use `redis://redis:6379` and `http://qdrant:6333`.

Replay a failed document (worker must be running):

```
bun run jobs:replay -- <documentId>
```

## Environments

Bun auto-loads env files by `NODE_ENV` (later wins):

```
.env
.env.{NODE_ENV}          # development / production / test
.env.local               # local overrides (not loaded when NODE_ENV=test)
.env.{NODE_ENV}.local    # per-environment secrets (gitignored)
```

`NODE_ENV` defaults to `development`. The `start` / `worker` scripts set `NODE_ENV=production`. Secrets (`QDRANT_API_KEY`, `REDIS_URL`) live in gitignored `*.local` files. Code branches via the typed `env` object in `src/config/env.ts` (`env.isProduction` / `isDevelopment` / `isTest`).

## Configuration

See `.env.example`; values are read in `src/config/env.ts`.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | API process |
| `NODE_ENV` / `LOG_LEVEL` | `development` / `info` | runtime + logging |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ connection |
| `SQLITE_PATH` | `./data/semantic-search.sqlite` | document store |
| `QDRANT_URL` | `http://localhost:6333` | no trailing slash |
| `QDRANT_API_KEY` | – | set for managed Qdrant |
| `COLLECTION_NAME` | `document_chunks` | single collection target |
| `VECTOR_SIZE` | `384` | must match embedding model |
| `EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` | any Xenova/HF model |
| `EMBEDDING_REVISION` | `main` | pin model and tokenizer to the same full HF commit SHA |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `500` / `50` | embedding-tokenizer tokens |
| `SEARCH_HNSW_EF` | `64` | ANN recall/latency tradeoff |
| `EMBEDDING_CACHE_SIZE` | `256` | cached query embeddings |
| `RRF_K` | `60` | reciprocal-rank constant for hybrid fusion |
| `RRF_DENSE_WEIGHT` | `1` | dense channel weight in RRF fusion |
| `RRF_SPARSE_WEIGHT` | `0` | sparse channel weight (`0` = dense-only); historical quality claims await re-evaluation |
| `RERANK_ENABLED` | `false` | opt-in cross-encoder rerank; dense-first remains the evaluated default recommendation |
| `RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | cross-encoder |
| `RERANK_REVISION` | `main` | pin reranker model and tokenizer to the same full HF commit SHA |
| `RERANK_CANDIDATES` | `15` | candidate pool ceiling before rerank (lower = faster, smaller recall window) |

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | process liveness |
| GET | `/ready` | Qdrant collection + Redis |
| GET | `/metrics` | BullMQ waiting/active/completed/failed per queue |
| POST | `/documents` | `202 { id, status: "queued" }` |
| GET | `/documents/:id` | pipeline status (`queued → chunking → embedding → indexing → ready \| failed`) |
| POST | `/search` | default `hybrid` (dense-first); `mode` may be `hybrid`, `dense`, or `rerank` |

`POST /search` accepts `query`, `limit` (1–50), `source`, `scoreThreshold` (0–1), `mode`, and returns `{ results: [...] }` plus a `Server-Timing` header (`embed`, `qdrant`, `rerank`, `total`).

```
curl -s -X POST http://localhost:3000/documents \
  -H 'content-type: application/json' \
  -d '{"title":"JWT","text":"JWT authentication allows...","source":"docs/auth.md"}'

curl -s -X POST http://localhost:3000/search \
  -H 'content-type: application/json' \
  -d '{"query":"How does JWT work?","limit":5}'
```

## Quality and performance

```
bun run eval               # dense / hybrid / rerank → eval-runs/<run-id>/
bun run eval:rrf           # RRF k × dense/sparse weight sweep → isolated run directory
bun run eval:rerank-pool   # rerank pool + warm latency → isolated run directory
bun run eval:chunks        # chunk sizes 250/25, 500/50, 800/80
bun run eval:models        # embedding bake-off
bun run eval:qdrant        # HNSW / int8 quantization sweep
bun run bench              # search latency percentiles → bench-results.json
bun run bench:ingest       # ingest throughput

Prefix any `eval*` command with `EVAL_FIXTURE_SET=fiqa-hn` to run against the BEIR FiQA corpus (3 393 docs) instead of the small smoke fixture.
```

## Development

```
bun test src
bun run type-check
bun run lint
bun run infra:down
```

Pre-commit hook runs `type-check` + Biome. CI runs SAST, TypeScript checking and offline unit tests (including evaluation metrics, sampling, statistics and artifact tests). Full retrieval benchmarks require an explicit separate run with a chosen Qdrant endpoint; no arbitrary quality-regression threshold is enabled.

## Layout

```
src/
  api/           Hono routes + handlers
  config/env.ts  typed environment
  db/            SQLite document store, Qdrant/Redis clients
  domain/        chunking, sparse vectors, tokenizer, rerank
  queue/         BullMQ queues, jobs, stats
  services/      document, embedding, search, rerank, vector
  workers/       ingest → chunk → embed → index, replay
  eval/ bench/   metrics harnesses + fixture corpus
docker/          Redis + Qdrant (CPU/memory limits)
```

## License

MIT
