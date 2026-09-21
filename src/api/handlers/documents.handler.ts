import type { Context } from "hono"
import { getDocument, submitDocument } from "../../services/document/submit"
import { documentCreateSchema } from "../../validation/document.schema"
import { parseBody } from "../../validation/parse"
import { notFoundError } from "../errors"

const toPublicDocument = (document: {
  id: string
  title: string
  source?: string
  status: string
  createdAt: string
  updatedAt: string
  lastError?: string
}) => ({
  id: document.id,
  title: document.title,
  source: document.source ?? null,
  status: document.status,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  lastError: document.lastError ?? null
})

const createDocument = async (c: Context) => {
  const input = parseBody(documentCreateSchema, await c.req.json())
  const document = await submitDocument(input)
  return c.json({ id: document.id, status: document.status }, 202)
}

const readDocument = async (c: Context) => {
  const id = c.req.param("id")
  if (!id) {
    throw notFoundError("Document id is required")
  }
  const document = await getDocument(id)
  return c.json(toPublicDocument(document))
}

export { createDocument, readDocument }
