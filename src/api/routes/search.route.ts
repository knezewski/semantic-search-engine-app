import { Hono } from "hono"
import { searchDocuments } from "../handlers/search.handler"

const search = new Hono()

search.post("/", searchDocuments)

export default search
