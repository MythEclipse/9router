/**
 * The pxpipe controls.
 *
 * Install and start can shell out to npm, so they are deliberately *not* here:
 * this transport is reachable with an API key, and a key that can trigger an
 * install is a key that can change what runs on the host. The dashboard's REST
 * routes keep those two, behind the password session.
 */
import { z } from "zod"

import { authed } from "../base.ts"

/** Absent means the endpoint's own default; the list-limit rule decides. */
const LimitInput = z.object({ limit: z.string().optional() }).optional()

export const pxpipeRouter = {
	status: authed.handler(async ({ context }) => context.useCases.pxpipe.status()),

	stop: authed.handler(async ({ context }) => context.useCases.pxpipe.stop()),

	reload: authed.handler(async ({ context }) => context.useCases.pxpipe.reload()),

	health: authed.handler(async ({ context }) => context.useCases.pxpipe.checkHealth()),

	stats: authed
		.input(LimitInput)
		.handler(async ({ input, context }) => context.useCases.pxpipe.stats(input?.limit)),

	logs: authed
		.input(LimitInput)
		.handler(async ({ input, context }) => context.useCases.pxpipe.logs(input?.limit)),
}
