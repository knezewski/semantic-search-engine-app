# Retrieval evaluation: document-v2

## Scope and migration

This evaluates retrieval, not generated answers. There is no LLM judge, answer faithfulness score, business automation threshold or claim of production readiness.

Metric-v1 artifacts and earlier published tables are invalidated for current comparisons. Duplicate retrieved document IDs could add NDCG gain more than once. The old pool sweep also used the first N queries, and old artifacts did not preserve ranked IDs/configuration. Do not clamp old scores or recompute confidence intervals over them: re-run retrieval. Existing artifacts are not deleted or overwritten.

## Metric contract

- Unit: **document**; relevance: binary membership in the query's gold document IDs.
- Start with the actual returned chunk window, normally **at most 10 chunks**. Collapse document IDs in order of first occurrence, then apply document cutoffs (1/5/10). There is **no backfill** from deeper candidates to obtain ten unique documents. A ten-chunk response can contain fewer than ten evaluated documents.
- A duplicate chunk from the same document does not count as another relevant document. Gold IDs are also deduplicated.
- Hits@K is binary, Recall@K divides recovered gold documents by all gold documents, NDCG@10 uses binary gain and ideal DCG over `min(10, gold count)` documents.
- `mrrAt10` means reciprocal rank of the first relevant document among the first ten unique documents within the supplied window. The standalone `reciprocalRank` helper remains unbounded.
- Empty gold sets receive zero retrieval metrics. This convention **does not evaluate correct abstention**. Use a separate no-answer metric before adding unanswerable cases to a product benchmark.
- Metrics are persisted at full precision; rounding belongs in presentation only.
- `relevantChunkIds` is not used as evidence annotation. Relevant documents do not imply all their chunks are answer-bearing. Chunk-level evidence evaluation remains a separate task.

All current runners declare `deduplicate-within-returned-chunks-no-backfill` in their manifest. Do not compare to an evaluator that retrieves until ten unique documents unless that different depth policy is explicitly reported.

## Datasets and sampling

- `smoke`: 12 small, hand-authored documents and 8 queries. Verifies wiring, not quality or statistical power.
- `fiqa-hn`: 3,393 documents and 648 FiQA test queries; includes gold documents plus BM25-mined distractors. It is a reduced-corpus stress set, not the standard full-corpus BEIR benchmark. Unjudged distractors are not proven irrelevant.
- The existing FiQA queries have already influenced defaults. Treat them as development data. Reserve genuinely unused queries for a final held-out decision; do not manufacture an independent test by renaming the same queries.
- `EVAL_QUERIES=0` uses all queries in original order. A positive cap smaller than the dataset uses seeded Fisher-Yates sampling without replacement. The exact selected ID list is saved.
- `EVAL_SEED` defaults to 42 and is a uint32. Use the same seed, cap and dataset hashes across paired experiments.
- `EVAL_RERANK_QUERIES` remains a legacy alias for the rerank sweep. If supplied together with `EVAL_QUERIES`, their values must agree.
- Built-in diagnostic slices cover gold-count (0/1/2–3/4+), query word-count (1–5/6–9/10+) and healthy/degraded execution, each with n. They do not replace domain, language, typo and risk labels.

Fixture validation rejects duplicate document/query IDs, malformed records and gold IDs missing from the corpus before any network request. Hashes cover the actual fixture text loaded by the runner.

## Paired comparisons

Every scored configuration retains full per-query metrics and is compared with its stated baseline on identical unique query IDs in identical order. The rerank pool sweep additionally compares each pool with pool 15.

The interval is a seeded percentile bootstrap over **paired per-query differences**, `variant − baseline`. Defaults: 2,000 resamples, 95% confidence; configure the count using `EVAL_BOOTSTRAP_RESAMPLES`. Sampling is shared between systems, not performed independently.

- CI includes zero: the difference is inconclusive, **not proof of equivalence**.
- CI excludes zero: evidence under this query sample and protocol, not proof of product value or a held-out gain.
- Intervals reflect query sampling, not between-run inference/index variation.
- Grid-search comparisons are exploratory and are **not corrected for multiple comparisons**. Confirm a selected configuration on untouched data.
- There is no arbitrary 2% regression gate. Agree on a minimum useful gain, risk-specific margins and sample size before enabling a quality gate.

General methodology: [Qdrant retrieval relevance evaluation](https://skills.qdrant.tech/md/documentation/search-evaluation/retrieval-relevance/) and [checking whether labels can detect a gain](https://skills.qdrant.tech/md/documentation/search-tuning/before-tuning-a-qdrant-collection/?s=make-sure-your-labels-can-detect-a-gain).

## Run artifacts and isolation

Each command creates `eval-runs/<timestamp-kind-uuid>/`:

- `manifest.json` is written before indexing, updated when collections are allocated, and marked completed after results are saved. A manifest still marked running means an incomplete/interrupted run, not a usable benchmark.
- `results.json` contains a completed manifest snapshot, per-configuration summaries/slices, raw per-query ranked chunk/document IDs, source scores where meaningful, timing/degradation details and paired comparisons.
- Candidate/source scores are retained in the RRF and rerank-pool sweeps. RRF result items contain original channel scores, not fused scores, so the fused ranking intentionally omits a misleading `score` field.
- The manifest records Git SHA/dirty status, Bun/platform/architecture, installed dependency versions, lockfile hash, fixture hashes, sample IDs, metric version, configuration, requested model revisions, Qdrant version and allocated collection names.
- Configuration is an explicit allowlist. API keys, Redis credentials and raw environment variables are not serialized. Only the Qdrant URL origin is retained; credentials, path, query and fragment are removed. Query text and query IDs **are** saved: treat artifacts as potentially sensitive when using real user data.
- Each run/variant gets a fresh UUID-scoped collection. Existing collections are never deleted or reused. If collection creation reports an existing collection, the run fails rather than mixing indexes.
- Collections are retained for inspection, including after failed runs. They consume storage: perform deliberate manual cleanup using the exact collection names recorded in the manifest. There is no automatic remote deletion.
- Local reports are ignored by Git. Archive the complete run directory in your CI artifact store when publishing a benchmark; do not publish an unversioned scalar table alone.

## Models and runtime reproducibility

Set `EMBEDDING_REVISION` and `RERANK_REVISION` to full Hugging Face commit SHAs. Embedding tokenizer and embedding model use the same requested revision; likewise the reranker tokenizer and classifier.

For `eval:models`, repositories need different SHAs:

```bash
EVAL_MODEL_REVISIONS='{"BAAI/bge-small-en-v1.5":"<bge-commit-sha>","Xenova/all-MiniLM-L6-v2":"<minilm-commit-sha>"}' bun run eval:models
```

Per-model overrides take precedence. `EMBEDDING_REVISION` applies only to the sweep model whose ID equals `EMBEDDING_MODEL`; other models default to `main` if no override is supplied.

A branch/tag such as `main` is mutable. The manifest records the requested revision and only marks full SHAs immutable. `resolvedRevision` remains null because the current runtime wrapper does not expose the resolved artifact commit. Inference backend is auto-selected and explicitly recorded as unverified; the harness does not infer WASM/native execution from latency. Fix these environmental details outside the evaluator when strict cross-machine repeatability is required.

## Fallbacks and latency

The main modes and chunk experiments use the serving search path and preserve embedding/Qdrant/sparse/reranker degradation signals. A run with degraded searches is saved with `validForQualityComparison=false` and exits nonzero after saving. Its quality comparisons must not be treated as measurements of the requested intact pipeline. Direct vector/model sweep failures abort rather than substituting another method.

### Independent rerank-pool quality

Each pool is scored in a separate reranker call. **Top-50 logits are no longer reused as the default measurement of smaller pools.** Choose the experiment explicitly:

- `EVAL_POOL_PROTOCOL=fixed-candidates` (default): retrieve top-50 once for each query, then separately score prefixes of 15/30/50 candidates. This isolates pool size on a shared candidate list, including any real batch-shape/padding effect.
- `EVAL_POOL_PROTOCOL=serving-depth`: retrieve at each pool's own depth and score that pool separately. This checks retrieval-depth effects as well as scoring effects; it is **not** a claim that the entire serving SearchService (fusion, fallbacks, caching, etc.) has been reproduced. Use `bun run eval` for the serving modes.

Preserve each pool's complete candidate provenance: document/chunk IDs, dense rank and score, passage-content hash, and independently obtained rerank scores. Do not retain passage text in results. Rankings use dense rank as a deterministic tie-break. Quality protocol/schema changes must be explicit in the artifact; old top-50-reuse artifacts are not interchangeable with independently rescored results. The document-v2 metric definition itself has not changed.

The runner now writes `schemaVersion=rerank-pool-v3-independent` and `legacyValidatorCompatible=false`. Historical ignored validator/report scripts created for the November 13/17 artifacts do not understand this schema: do not silently reinterpret a v3 run using them. Full per-pool raw evidence is covered by offline reconstruction tests.

### Repeated latency measurements

- serial concurrency=1; no competing benchmark stages are intentionally started by the runner;
- up to `EVAL_LATENCY_QUERIES` distinct queries (default 100), independently seeded from the quality sample;
- `EVAL_LATENCY_REPEATS=3` measured repetitions by default; `EVAL_LATENCY_WARMUP_ROUNDS=1` excluded warmup round by default;
- identical sampled queries for every pool/repeat, with rotated pool order across queries and repeats;
- retain raw durations, actual candidate counts, repeat indices, execution order, sample IDs, and any explicitly measured stage durations;
- publish per-repeat and aggregate quantiles and descriptive between-repeat spread. Three repeats of 100 queries are **100 distinct queries**, not 300 independent queries;
- record which stages were actually timed: cached-candidate reranker-only measurements are not end-to-end. Only claim embedding/retrieval/end-to-end timing where the runner measures those operations;
- warn about small distinct-query samples. Repeating a tiny sample does not make p95/p99 reliable.

**Latency scope changed in v3:** `latencyMs.p50/p95` now summarize the warm vector-path callback (embedding service → retrieval → rerank), not the historical reranker-only duration. Use `latencyMs.stagesMs.rerank` and per-repeat stage summaries to inspect the reranker component; do not directly compare the new aggregate field with old reranker-only tables. Embedding cache hits are possible and explicitly declared. This path does not include HTTP, sparse fusion, fallbacks or complete serving response processing.

Runtime metadata captures hardware, memory/load indicators and known inference settings before/after a run and immediately around the latency phase. Reranker q8 dtype, padding/truncation and call-level batch policy are declared implementation settings, not inferred from speed. Environment thread hints are not proof of applied ONNX session options; auto-selected backend and unexposed settings remain unknown. This instrumentation does not lock CPU frequency, host load or backend by itself. For SLA work, use a controlled host and repeated loaded-service trials.

These are exploratory warm latency measurements, not a cold-start, loaded-service or p99 SLA certification. Qdrant search latency is measured separately from embedding latency. The Qdrant sweep saves index readiness snapshots: small collections may not have built HNSW or quantization yet, so changes in settings alone do not establish a measured ANN/quantization effect.

## Running safely

Bun loads local environment files. Explicitly select the Qdrant endpoint to avoid accidentally using a configured Cloud deployment. Commands below require a running local Qdrant and may download model files; they create collections but do not delete old ones.

```bash
# Offline correctness checks: no model loading or cloud benchmark.
bun run type-check
bun test src

# Small retrieval wiring run; explicitly override inherited cloud settings.
QDRANT_URL=http://localhost:6333 QDRANT_API_KEY= EVAL_FIXTURE_SET=smoke bun run eval

# Full available FiQA stress set with the new metric version.
QDRANT_URL=http://localhost:6333 QDRANT_API_KEY= EVAL_FIXTURE_SET=fiqa-hn EVAL_QUERIES=0 EVAL_SEED=42 bun run eval

# Exploratory sweeps, same seeded quality sample.
QDRANT_URL=http://localhost:6333 QDRANT_API_KEY= EVAL_FIXTURE_SET=fiqa-hn EVAL_QUERIES=200 EVAL_SEED=42 bun run eval:rrf
QDRANT_URL=http://localhost:6333 QDRANT_API_KEY= EVAL_FIXTURE_SET=fiqa-hn EVAL_QUERIES=200 EVAL_SEED=42 EVAL_POOL_PROTOCOL=fixed-candidates EVAL_LATENCY_REPEATS=3 EVAL_LATENCY_WARMUP_ROUNDS=1 bun run eval:rerank-pool

# Separate retrieval-depth experiment: creates another isolated collection.
QDRANT_URL=http://localhost:6333 QDRANT_API_KEY= EVAL_FIXTURE_SET=fiqa-hn EVAL_QUERIES=200 EVAL_SEED=42 EVAL_POOL_PROTOCOL=serving-depth EVAL_LATENCY_REPEATS=3 bun run eval:rerank-pool
```

CI runs offline unit/artifact tests and type checking alongside SAST. Full retrieval runs are deliberately not automatic against ambient cloud credentials.

## Before publishing replacement benchmark results

1. Pin model/tokenizer revisions; record hardware/backend and chosen endpoint.
2. Run the smoke retrieval command against an explicitly selected test deployment.
3. Run the full quality sample and sweeps; require zero degraded queries and inspect index readiness.
4. Review per-query errors, slice sizes and paired CIs. Repeat runs to assess runtime/index variation.
5. Compare full-corpus or random-distractor controls before generalizing a hard-negative result.
6. Confirm the chosen configuration on unused held-out queries.
7. Archive complete run directories and publish metric version, sample size, retrieval depth, deltas/CIs and latency protocol.

Still separate work: human-verified evidence-span labels, production-domain/typo/no-answer slices, calibration of business usefulness and abstention thresholds, retrieval candidate-coverage attribution, and generator-only/end-to-end evaluation when a generator exists.
