import type { Context } from "hono"
import { getQdrantClient } from "../../db/qdrant.client"
import { SearchService } from "../../services/search"
import { parseBody } from "../../validation/parse"
import { searchRequestSchema } from "../../validation/search.schema"

const searchService = new SearchService(getQdrantClient())

const searchDocuments = async (c: Context) => {
  const input = parseBody(searchRequestSchema, await c.req.json())
  const timed = await searchService.searchTimed({
    query: input.query,
    limit: input.limit,
    source: input.source,
    scoreThreshold: input.scoreThreshold,
    mode: input.mode
  })

  c.header(
    "Server-Timing",
    `embed;dur=${timed.embedMs.toFixed(1)}, qdrant;dur=${timed.qdrantMs.toFixed(1)}, rerank;dur=${timed.rerankMs.toFixed(1)}, total;dur=${timed.totalMs.toFixed(1)}`
  )

  return c.json({ results: timed.hits })
}

export { searchDocuments }
