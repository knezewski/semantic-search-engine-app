import type { Context } from "hono"
import { getQueueStats } from "../../queue/stats"

const metrics = async (c: Context) => {
  const stats = await getQueueStats()
  return c.json({
    status: "ok",
    ...stats
  })
}

export { metrics }
