/**
 * System procedures — unauthenticated by design.
 *
 * Health must answer before auth is configured, otherwise a fresh install looks
 * down and every orchestrator restarts a server that is actually fine.
 */
import { base } from "../base.ts"
import { HealthSchema } from "../schemas.ts"

const startedAt = Date.now()

export const systemRouter = {
	health: base.output(HealthSchema).handler(() => ({
		status: "ok" as const,
		uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
	})),
}
