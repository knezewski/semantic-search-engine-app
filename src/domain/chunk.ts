/**
 * Token-window chunking aligned with the embedding tokenizer.
 * CHUNK_SIZE / CHUNK_OVERLAP are token counts, not characters.
 */
import { env } from "../config/env"
import { chunkIdFor } from "../utils/hash"
import type { DocumentChunk, DocumentRecord } from "./document"
import { getTokenizer, type TokenizerPort } from "./tokenizer"

interface ChunkOptions {
  chunkSize?: number
  chunkOverlap?: number
  tokenizer?: TokenizerPort
}

const windowTokenIds = (tokenIds: number[], chunkSize: number, chunkOverlap: number): number[][] => {
  if (tokenIds.length === 0) return []
  if (tokenIds.length <= chunkSize) return [tokenIds]

  const step = chunkSize - chunkOverlap
  const windows: number[][] = []
  for (let start = 0; start < tokenIds.length; start += step) {
    windows.push(tokenIds.slice(start, start + chunkSize))
    if (start + chunkSize >= tokenIds.length) break
  }
  return windows
}

const chunkText = async (text: string, options: ChunkOptions = {}): Promise<string[]> => {
  const chunkSize = options.chunkSize ?? env.chunkSize
  const chunkOverlap = options.chunkOverlap ?? env.chunkOverlap
  if (chunkOverlap >= chunkSize) {
    throw new Error("chunkOverlap must be smaller than chunkSize")
  }

  const normalized = text.trim()
  if (!normalized) return []

  const tokenizer = options.tokenizer ?? getTokenizer()
  const tokenIds = await tokenizer.encode(normalized)
  if (tokenIds.length === 0) return []

  const windows = windowTokenIds(tokenIds, chunkSize, chunkOverlap)
  const chunks: string[] = []
  for (const window of windows) {
    const decoded = (await tokenizer.decode(window)).trim()
    if (decoded) chunks.push(decoded)
  }
  return chunks
}

const splitDocument = async (document: DocumentRecord, options: ChunkOptions = {}): Promise<DocumentChunk[]> => {
  const texts = await chunkText(document.text, options)
  return texts.map((text, position) => ({
    chunkId: chunkIdFor(document.id, position),
    documentId: document.id,
    text,
    title: document.title,
    source: document.source,
    position
  }))
}

export type { ChunkOptions }
export { chunkText, splitDocument, windowTokenIds }
