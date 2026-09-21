import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { env } from "../config/env"
import type { DocumentChunk, DocumentRecord, DocumentStatus } from "../domain/document"
import type { EmbeddedChunk } from "../domain/embedding"

interface DocumentRow {
  id: string
  title: string
  text: string
  source: string | null
  status: DocumentStatus
  created_at: string
  updated_at: string
  last_error: string | null
}

interface ChunkRow {
  document_id: string
  position: number
  chunk_id: string
  text: string
  title: string
  source: string | null
}

interface EmbeddingRow extends ChunkRow {
  vector_json: string
}

const toDocument = (row: DocumentRow): DocumentRecord => ({
  id: row.id,
  title: row.title,
  text: row.text,
  source: row.source ?? undefined,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastError: row.last_error ?? undefined
})

class DocumentStore {
  private readonly db: Database

  constructor(path: string) {
    if (dirname(path)) {
      mkdirSync(dirname(path), { recursive: true })
    }
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS chunks (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        chunk_id TEXT NOT NULL,
        text TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT,
        PRIMARY KEY (document_id, position)
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        chunk_id TEXT NOT NULL,
        text TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT,
        vector_json TEXT NOT NULL,
        PRIMARY KEY (document_id, position)
      );
    `)
  }

  async save(document: DocumentRecord): Promise<void> {
    this.db
      .query(
        `INSERT INTO documents (id, title, text, source, status, created_at, updated_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           text = excluded.text,
           source = excluded.source,
           status = excluded.status,
           updated_at = excluded.updated_at,
           last_error = excluded.last_error`
      )
      .run(
        document.id,
        document.title,
        document.text,
        document.source ?? null,
        document.status,
        document.createdAt,
        document.updatedAt,
        document.lastError ?? null
      )
  }

  async get(id: string): Promise<DocumentRecord | null> {
    const row = this.db.query("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | null
    return row ? toDocument(row) : null
  }

  async require(id: string): Promise<DocumentRecord> {
    const document = await this.get(id)
    if (!document) {
      throw new Error(`Document ${id} not found`)
    }
    return document
  }

  async updateStatus(id: string, status: DocumentStatus, lastError?: string): Promise<DocumentRecord> {
    this.db
      .query("UPDATE documents SET status = ?, updated_at = ?, last_error = ? WHERE id = ?")
      .run(status, new Date().toISOString(), status === "failed" ? (lastError ?? null) : null, id)
    return this.require(id)
  }

  async saveChunks(documentId: string, chunks: DocumentChunk[]): Promise<void> {
    const replace = this.db.transaction(() => {
      this.db.query("DELETE FROM chunks WHERE document_id = ?").run(documentId)
      const insert = this.db.query(
        "INSERT INTO chunks (document_id, position, chunk_id, text, title, source) VALUES (?, ?, ?, ?, ?, ?)"
      )
      for (const chunk of chunks) {
        insert.run(documentId, chunk.position, chunk.chunkId, chunk.text, chunk.title, chunk.source ?? null)
      }
    })
    replace()
  }

  async getChunks(documentId: string): Promise<DocumentChunk[]> {
    const rows = this.db
      .query("SELECT * FROM chunks WHERE document_id = ? ORDER BY position")
      .all(documentId) as ChunkRow[]
    return rows.map(row => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      text: row.text,
      title: row.title,
      source: row.source ?? undefined,
      position: row.position
    }))
  }

  async saveEmbeddings(documentId: string, embeddings: EmbeddedChunk[]): Promise<void> {
    const replace = this.db.transaction(() => {
      this.db.query("DELETE FROM embeddings WHERE document_id = ?").run(documentId)
      const insert = this.db.query(
        "INSERT INTO embeddings (document_id, position, chunk_id, text, title, source, vector_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      for (const item of embeddings) {
        insert.run(
          documentId,
          item.position,
          item.chunkId,
          item.text,
          item.title,
          item.source ?? null,
          JSON.stringify(item.vector)
        )
      }
    })
    replace()
  }

  async getEmbeddings(documentId: string): Promise<EmbeddedChunk[]> {
    const rows = this.db
      .query("SELECT * FROM embeddings WHERE document_id = ? ORDER BY position")
      .all(documentId) as EmbeddingRow[]
    return rows.map(row => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      text: row.text,
      title: row.title,
      source: row.source ?? undefined,
      position: row.position,
      vector: JSON.parse(row.vector_json) as number[]
    }))
  }

  async delete(id: string): Promise<void> {
    this.db.query("DELETE FROM documents WHERE id = ?").run(id)
  }
}

const documentStore = new DocumentStore(env.sqlitePath)

export { DocumentStore, documentStore }
