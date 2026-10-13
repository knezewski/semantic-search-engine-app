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

## Current results

Measured on the BEIR **FiQA** test split — **3 393 documents, 648 queries** with BM25-selected hard negatives (the 30-doc fixture is only a smoke test). Embeddings `BAAI/bge-small-en-v1.5`. Reproduce:

```bash
EVAL_FIXTURE_SET=fiqa-hn bun run eval              # modes → eval-results-fiqa-hn.json
EVAL_FIXTURE_SET=fiqa-hn bun run eval:rrf          # RRF k × weights → eval-rrf-results.json
EVAL_FIXTURE_SET=fiqa-hn bun run eval:rerank-pool  # rerank pool + latency → eval-rerank-pool-results.json
```

### Modes

| Mode | Recall@1 | Recall@10 | MRR | NDCG@10 |
| --- | --- | --- | --- | --- |
| dense | 0.2721 | **0.6422** | **0.6289** | **0.5713** |
| hybrid (BM25 1:1, k=60) | 0.1561 | 0.5901 | 0.4831 | 0.4523 |
| rerank (MiniLM, pool=15) | 0.2269 | 0.6145 | 0.5682 | 0.5228 |

> `dense` wins on every ranking metric. Equal-weight BM25 fusion *hurts*: it drops MRR 0.629 → 0.483 and NDCG@10 0.571 → 0.452. Rerank recovers part of it but still trails dense.

### RRF fusion sweep (dense vs BM25 weight)

| Config | Recall@10 | MRR | NDCG@10 |
| --- | --- | --- | --- |
| dense (BM25 weight 0) | 0.6422 | **0.6289** | **0.5713** |
| dense 1 : BM25 0.25, k=10 | **0.6492** | 0.5934 | 0.5523 |
| dense 1 : BM25 1, k=60 (old default) | 0.5899 | 0.4845 | 0.4528 |

> BM25 is the weak channel on FiQA — the more weight it gets, the lower MRR/NDCG. Ranking accuracy is dense-first, so `RRF_SPARSE_WEIGHT` now defaults to `0` (BM25 stays opt-in).

### Rerank pool trade-off (200-query sample)

| Pool | Recall@10 | MRR | NDCG@10 | rerank p50 | rerank p95 |
| --- | --- | --- | --- | --- | --- |
| dense (no rerank) | 0.5948 | **0.5866** | **0.5315** | 0 | 0 |
| 15 | **0.6141** | 0.5218 | 0.5021 | 2.67 s | 3.81 s |
| 30 | 0.6070 | 0.5113 | 0.4934 | 3.81 s | 4.18 s |
| 50 | 0.6134 | 0.5059 | 0.4906 | 6.32 s | 8.58 s |

> Bigger pools **don't help** — MRR/NDCG fall as the weak reranker gets more candidates to mis-rank. Measured cross-encoder latency is **2.7–8.6 s/query**, far above the 0.5–1.1 s first assumed: `ms-marco-MiniLM-L-6` appears to run in **wasm** here (Bun doesn't load `onnxruntime-node`), so the bottleneck is the rerank runtime, not the pool size.

### Takeaways

- **dense-first is the right default on FiQA** — BM25 and the current reranker both cost ranking accuracy.
- The knobs stay wired (`RRF_K`, channel weights, `RERANK_CANDIDATES`, `RERANK_MODEL`) for corpora where lexical/rerank signal helps.
- **To make rerank practical**, run the cross-encoder natively (onnxruntime-node under Node, or a separate Python/FastAPI rerank service) — wasm is the latency ceiling here.

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
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `500` / `50` | embedding-tokenizer tokens |
| `SEARCH_HNSW_EF` | `64` | ANN recall/latency tradeoff |
| `EMBEDDING_CACHE_SIZE` | `256` | cached query embeddings |
| `RRF_K` | `60` | reciprocal-rank constant for hybrid fusion |
| `RRF_DENSE_WEIGHT` | `1` | dense channel weight in RRF fusion |
| `RRF_SPARSE_WEIGHT` | `0` | BM25 channel weight (`0` = dense-only; FiQA sweep showed BM25 hurts MRR/NDCG) |
| `RERANK_ENABLED` | `false` | opt-in cross-encoder rerank (default mode stays `hybrid`) |
| `RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | cross-encoder |
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
bun run eval               # dense vs hybrid vs rerank → eval-results.json
bun run eval:rrf           # RRF k × dense/BM25 weight sweep → eval-rrf-results.json
bun run eval:rerank-pool   # rerank candidate pool + latency → eval-rerank-pool-results.json
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

Pre-commit hook runs `type-check` + Biome. CI runs SAST.

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
