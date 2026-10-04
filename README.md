# Semantic Document Retrieval Engine

Production-shaped backend for semantic document search: HTTP ingest → BullMQ workers → Qdrant → hybrid retrieval with cross-encoder reranking. Built in TypeScript on Bun, with evaluation and latency harnesses baked in from day one.

**Why it exists:** retrieval quality is only as good as what you measure. This repo pairs a hybrid search pipeline with a reproducible eval loop (Recall@K / MRR / NDCG) and per-request latency breakdowns, so retrieval changes are judged on numbers, not vibes.

```
Client → Hono API → Service → BullMQ (Redis) → Ingest → Chunk → Embed → Index → Qdrant → POST /search
```

## Features

- **Hybrid retrieval:** dense + BM25 sparse, fused with Reciprocal Rank Fusion (RRF).
- **Reranking:** optional cross-encoder rerank over the hybrid candidate pool (default search mode).
- **Measured quality:** Recall@K / MRR / NDCG harness over a fixed fixture corpus; chunk-size, embedding-model, and Qdrant quantization sweeps.
- **Latency transparency:** `Server-Timing` response header splitting `embed` / `qdrant` / `rerank` / `total`; search-percentile and ingest-throughput benchmarks.
- **Resilient ingest:** four BullMQ queues + workers, 3 attempts with exponential backoff, manual replay, deterministic chunk ids, idempotent `document_chunks` collection with payload indexes.
- **Operable:** `/health`, `/ready`, `/metrics`; circuit breaker and graceful shutdown; typed env; SQLite document store.

## Current results

> Measured locally on the fixture corpus (30 documents, 73 queries, `EMBEDDING_MODEL=BAAI/bge-small-en-v1.5`). Reproduce with `bun run eval` / `bun run bench`.

| Mode | Recall@5 | MRR | NDCG@10 |
| --- | --- | --- | --- |
| dense | 1.000 | 0.966 | 0.975 |
| hybrid | 1.000 | 0.973 | 0.980 |
| rerank | 1.000 | 0.986 | 0.990 |

> Recall@5 is saturated (1.0) on this corpus; MRR/NDCG@10 discriminate and rank dense < hybrid < rerank.

| Metric | p50 | p95 |
| --- | --- | --- |
| `/search` latency (ms) | 1124 | 1709 |

> Status (2026-10-04): reranking returns real cross-encoder scores (the previous implementation always returned 0), and ingest fails fast with `503 NOT_READY` when Redis is down. Manual test cases **SRCH-06** and **ERR-04** now pass.

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
| `RERANK_ENABLED` | `true` | makes `rerank` the default mode |
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
| POST | `/search` | default `rerank`; `mode` may be `hybrid` or `dense` |

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
bun run eval          # dense vs hybrid vs rerank → eval-results.json
bun run eval:chunks   # chunk sizes 250/25, 500/50, 800/80
bun run eval:models   # embedding bake-off
bun run eval:qdrant   # HNSW / int8 quantization sweep
bun run bench         # search latency percentiles → bench-results.json
bun run bench:ingest  # ingest throughput
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
