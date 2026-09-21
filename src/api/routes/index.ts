import { Hono } from "hono"
import documents from "./documents.route"
import probes from "./health.route"
import search from "./search.route"

const routes = new Hono()

routes.route("/", probes)
routes.route("/documents", documents)
routes.route("/search", search)

export default routes
