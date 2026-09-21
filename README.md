# Semantic Document Retrieval Engine

Backend retrieval infrastructure: HTTP ingest → BullMQ workers → Qdrant → semantic search.

This is not a chatbot UI. The public contract is document ingest, pipeline status, and search.

```text
Client
  ↓
Hono API
  ↓
Service
  ↓
BullMQ / Redis
  ↓
Ingest → Chunk → Embed → Index workers
  ↓
Qdrant
  ↓
POST /search
```

## Status

- Phase 0 done: env, pinned Docker infra, CI, toolchain.
- Phase 1 done: document/chunk domain, deterministic ids, SQLite document store, idempotent `document_chunks` collection + payload indexes.
- Phase 2 done: `POST /documents`, `GET /documents/:id`, `POST /search`, `/health`, `/ready`.
- Phase 3 done: four BullMQ queues + workers, retries, replay.
- Phase 4 done: `EmbeddingPort`, lazy HF adapter, `embed` / `embedBatch`, model from `EMBEDDING_MODEL`.
- Phase 6 done: Recall@K / MRR / NDCG on a fixed fixture corpus.
- Latency: embedding warmup + query cache + HNSW `ef` + `Server-Timing` + `bun run bench`.
- Hybrid search: dense + BM25 sparse, RRF fusion. `"mode": "dense"` to disable.
- Eval compares dense vs hybrid vs rerank on the same fixture set.
- Rerank: cross-encoder `Xenova/ms-marco-MiniLM-L-6-v2` over the hybrid candidate pool.
- Chunking uses the embedding tokenizer (`CHUNK_SIZE` / `CHUNK_OVERLAP` in tokens). `bun run eval:chunks` compares 250/25, 500/50, 800/80.
- Ingest throughput: `bun run bench:ingest`.
- Embedding bake-off: `bun run eval:models`.
- HNSW / int8 quantization sweep: `bun run eval:qdrant`.
- Queue counts: `GET /metrics`. Compose has CPU/memory limits.
- Outside the spec: `my-plugin` still talks to the old API.

```bash
bun test src
bun run eval
bun run eval:chunks
bun run eval:models
bun run eval:qdrant
bun run bench
bun run bench:ingest
```

On API start the process calls `VectorService.ensureCollection()` for `COLLECTION_NAME` (default `document_chunks`).

## Prerequisites

- [Bun](https://bun.sh)
- Docker (Redis + Qdrant)

## Run locally

```bash
cp .env.example .env
bun install
bun run infra:up
bun run dev
bun run dev:worker   # second terminal
```

- API: `http://localhost:3000`
- Health: `GET /health` — ready: `GET /ready`
- Qdrant dashboard: `http://localhost:6333/dashboard`
- Redis: `localhost:6379`

Replay a failed document after the worker is running:

```bash
bun run jobs:replay -- <documentId>
```

```bash
bun run type-check
bun test src
bun run infra:down
```

## Configuration

See `.env.example`. Values are read from `src/config/env.ts`.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | API process |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ queue connection |
| `SQLITE_PATH` | `./data/semantic-search.sqlite` | SQLite document store file |
| `QDRANT_URL` | `http://localhost:6333` | no trailing slash |
| `COLLECTION_NAME` | `document_chunks` | single collection target |
| `VECTOR_SIZE` | `384` | must match embedding model |
| `EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` | swapped via service later |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `500` / `50` | tokens of the embedding tokenizer |
| `RERANK_ENABLED` | `true` | default search mode becomes `rerank` |
| `RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | cross-encoder |
| `RERANK_CANDIDATES` | `20` | pool size before rerank |

If the API later runs *inside* Compose, use `redis://redis:6379` and `http://qdrant:6333`.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | process liveness |
| GET | `/ready` | Qdrant collection + Redis |
| GET | `/metrics` | BullMQ waiting/active/completed/failed |
| POST | `/documents` | `202 { id, status: "queued" }` |
| GET | `/documents/:id` | pipeline status, no `text` |
| POST | `/search` | default `rerank` (hybrid + cross-encoder); `"mode": "hybrid"` or `"dense"` |

```bash
curl -s -X POST http://localhost:3000/documents \
  -H 'content-type: application/json' \
  -d '{"title":"JWT","text":"JWT authentication allows...","source":"docs/auth.md"}'

curl -s -X POST http://localhost:3000/search \
  -H 'content-type: application/json' \
  -d '{"query":"How does JWT work?","limit":5}'
```

## Layout

```text
src/
  api/           HTTP adapters
  config/env.ts  typed environment
  db/            SQLite store + Qdrant/Redis clients
  domain/        chunking / prompts
  services/      document, embedding, search, vector
docker/          Redis + Qdrant
```
