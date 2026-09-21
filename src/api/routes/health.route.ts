import { Hono } from "hono"
import { health, ready } from "../handlers/health.handler"
import { metrics } from "../handlers/metrics.handler"

const probes = new Hono()

probes.get("/health", health)
probes.get("/ready", ready)
probes.get("/metrics", metrics)

export default probes
