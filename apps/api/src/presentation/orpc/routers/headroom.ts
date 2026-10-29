/**
 * Headroom proxy procedures.
 *
 * Two responses are shaped by the route rather than by the use-case, and both are
 * statements about HTTP that the use-case has no business knowing:
 *
 * - `stop` answers 200 with `stopped: true`, or 409 with `stopped: false`. Nothing to stop
 *   means the caller asked for a state change that did not happen, and a 200 leaves the
 *   dashboard showing "stopped" for a proxy it never had. The status travels in the body
 *   (`status`) because oRPC carries data, not status codes — see the route.
 * - A remote URL is a 400: the URL is wrong for *this* operation, not the caller's identity,
 *   and the same request works once they point it at a local proxy. `AppError` carries that
 *   number, so it arrives as a 400 rather than a 500.
 *
 * Everything here is behind the password session. Starting a process is not a thing an API
 * key should reach, and none of these paths is on `PUBLIC_API_PATHS`.
 */
import { z } from "zod"
import { authed } from "../base.ts"

const Extras = z.object({ extras: z.array(z.unknown()).optional() }).optional()

export const headroomRouter = {
	/** Installed, running, the managed pid, and the URL this install talks to. */
	status: authed.handler(async ({ context }) => context.useCases.headroom.status()),

	/** Start a local proxy. A remote URL is refused before anything is spawned. */
	start: authed.handler(async ({ context }) => context.useCases.headroom.start()),

	/** Same gate as `start`: a restart of a proxy this install never started is not one. */
	restart: authed.handler(async ({ context }) => context.useCases.headroom.restart()),

	/** Stop the managed proxy. `status` in the body is 200 or 409 — see the route. */
	stop: authed.handler(async ({ context }) => context.useCases.headroom.stop()),

	/** The compression extras: which are available, which are installed, or the live log. */
	extras: {
		read: authed
			.input(z.object({ log: z.boolean().optional() }).optional())
			.handler(async ({ input, context }) =>
				context.useCases.headroom.extras.read({ log: input?.log }),
			),

		install: authed
			.input(Extras)
			.handler(async ({ input, context }) =>
				context.useCases.headroom.extras.install(input?.extras ?? []),
			),

		uninstall: authed
			.input(Extras)
			.handler(async ({ input, context }) =>
				context.useCases.headroom.extras.uninstall(input?.extras ?? []),
			),
	},
}

export type HeadroomRouter = typeof headroomRouter
