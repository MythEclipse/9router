/**
 * Process-level procedures: custom plugins, cache counters, dashboard jobs.
 *
 * The shutdown pair is deliberately absent. Ending the process is not something
 * a remote JSON caller over an API-key session should be able to trigger, and
 * keeping it out of this transport is cheaper than re-deciding the gate here.
 */
import { z } from "zod"

import { authed } from "../base.ts"

const PluginEntry = z.object({
	enabled: z.boolean().optional(),
	models: z.array(z.string()).optional(),
})

const PluginWriteInput = z.object({ customPlugins: z.record(z.string(), PluginEntry) })

const JobStartInput = z.object({
	kind: z.string().min(1),
	title: z.string().optional(),
	payload: z.record(z.string(), z.unknown()).optional(),
})

const JobIdInput = z.object({ id: z.string().min(1) })

export const pluginsRouter = {
	read: authed.handler(async ({ context }) => context.useCases.readPlugins()),

	write: authed
		.input(PluginWriteInput)
		.handler(async ({ input, context }) => context.useCases.writePlugins(input)),
}

export const cacheStatsRouter = {
	read: authed.handler(async ({ context }) => context.useCases.cacheStats.read()),

	reset: authed.handler(async ({ context }) => context.useCases.cacheStats.reset()),
}

export const dashboardJobsRouter = {
	start: authed
		.input(JobStartInput)
		.handler(async ({ input, context }) => context.useCases.dashboardJobs.start(input)),

	read: authed
		.input(JobIdInput)
		.handler(async ({ input, context }) => context.useCases.dashboardJobs.read(input.id)),

	live: authed.handler(async ({ context }) => context.useCases.dashboardJobs.live()),

	cancel: authed
		.input(JobIdInput)
		.handler(async ({ input, context }) => context.useCases.dashboardJobs.cancel(input.id)),
}
