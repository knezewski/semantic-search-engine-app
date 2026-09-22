# Semantic Document Retrieval Engine

Backend for semantic document search: HTTP ingest → BullMQ workers → Qdrant → hybrid retrieval with reranking.

Public contract: document ingest, pipeline status, search.

```text
Client → Hono API → Service → BullMQ (Redis) → Ingest → Chunk → Embed → Index → Qdrant → POST /search
```

## Features

- Deterministic chunk ids, SQLite document store, idempotent `document_chunks` collection with payload indexes.
- Four BullMQ queues + workers, 3 attempts with exponential backoff, manual replay.
- Embeddings via a lazy Hugging Face adapter (`embed` / `embedBatch`), model from `EMBEDDING_MODEL`.
- Chunking uses the embedding tokenizer, so `CHUNK_SIZE` / `CHUNK_OVERLAP` are in tokens.
- Hybrid search: dense + BM25 sparse, fused with RRF.
- Optional cross-encoder rerank over the hybrid candidate pool (default search mode).
- Query embedding cache, HNSW `ef` tuning, `Server-Timing` response header.
- Quality and perf harnesses: Recall@K / MRR / NDCG on a fixed fixture corpus, search and ingest benchmarks,
  chunk-size / model / Qdrant sweeps.

## Prerequisites

- [Bun](https://bun.sh)
- Docker (Redis + Qdrant)

## Run locally

```bash
cp .env.example .env
bun install
bun run infra:up
bun run dev          # API
bun run dev:worker   # second terminal
```

- API: `http://localhost:3000`
- Qdrant dashboard: `http://localhost:6333/dashboard`
- Redis: `localhost:6379`

On start the API verifies Qdrant, calls `VectorService.ensureCollection()`, and warms up the embedding (and rerank)
models. If the API later runs *inside* Compose, use `redis://redis:6379` and `http://qdrant:6333`.

Replay a failed document (worker must be running):

```bash
bun run jobs:replay -- <documentId>
```

## Configuration

See `.env.example`; values are read in `src/config/env.ts`.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | API process |
| `NODE_ENV` / `LOG_LEVEL` | `development` / `info` | runtime + logging |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ connection |
| `SQLITE_PATH` | `./data/semantic-search.sqlite` | document store file |
| `QDRANT_URL` | `http://localhost:6333` | no trailing slash |
| `QDRANT_API_KEY` | – | set for managed Qdrant |
| `COLLECTION_NAME` | `document_chunks` | single collection target |
| `VECTOR_SIZE` | `384` | must match embedding model |
| `EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` | any Xenova/HF model |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `500` / `50` | embedding-tokenizer tokens |
| `SEARCH_HNSW_EF` | `64` | ANN recall/latency tradeoff |
| `EMBEDDING_CACHE_SIZE` | `256` | cached query embeddings |
| `RERANK_ENABLED` | `true` | makes `rerank` the default search mode |
| `RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | cross-encoder |
| `RERANK_CANDIDATES` | `20` | candidate pool before rerank |

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | process liveness |
| GET | `/ready` | Qdrant collection + Redis |
| GET | `/metrics` | BullMQ waiting/active/completed/failed per queue |
| POST | `/documents` | `202 { id, status: "queued" }` |
| GET | `/documents/:id` | pipeline status (`queued` → `chunking` → `embedding` → `indexing` → `ready` \| `failed`), no `text` |
| POST | `/search` | default `rerank`; `mode` may be `hybrid` or `dense` |

`POST /search` accepts `query`, `limit` (1–50), `source`, `scoreThreshold` (0–1), `mode` and returns
`{ results: [...] }` plus a `Server-Timing` header (`embed`, `qdrant`, `rerank`, `total`).

```bash
curl -s -X POST http://localhost:3000/documents \
  -H 'content-type: application/json' \
  -d '{"title":"JWT","text":"JWT authentication allows...","source":"docs/auth.md"}'

curl -s -X POST http://localhost:3000/search \
  -H 'content-type: application/json' \
  -d '{"query":"How does JWT work?","limit":5}'
```

## Quality and performance

```bash
bun run eval          # dense vs hybrid vs rerank → eval-results.json
bun run eval:chunks   # chunk sizes 250/25, 500/50, 800/80
bun run eval:models   # embedding bake-off
bun run eval:qdrant   # HNSW / int8 quantization sweep
bun run bench         # search latency percentiles → bench-results.json
bun run bench:ingest  # ingest throughput
```

## Development

```bash
bun test src
bun run type-check
bun run lint
bun run infra:down
```

A pre-commit hook runs `type-check` + Biome. CI runs GitLab SAST.

## Layout

```text
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
