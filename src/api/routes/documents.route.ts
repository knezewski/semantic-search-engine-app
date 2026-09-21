import { Hono } from "hono"
import { createDocument, readDocument } from "../handlers/documents.handler"

const documents = new Hono()

documents.post("/", createDocument)
documents.get("/:id", readDocument)

export default documents
