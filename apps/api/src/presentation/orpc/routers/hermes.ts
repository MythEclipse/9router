/**
 * Hermes Agent settings procedures.
 *
 * Three verbs over `~/.hermes[/profiles/<name>]/config.yaml`. The YAML rules are in
 * `domain/hermes-yaml`, the profile paths in `domain/hermes-profiles`, and the policies in the
 * use-case; this file hands over the host port and resolves one precedence.
 *
 * The profile can arrive from the body *or* the query string, because the CLI quick-setup posts a
 * body while the screen links with `?profile=`. The body wins, and resolving that here keeps the
 * use-case dealing in one value instead of two optional ones.
 */
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import { type AppContext, authed } from "../base.ts"

type HermesHost = NonNullable<AppContext["hermesHosts"]>

const hostOf = (host: HermesHost | undefined): HermesHost => {
	if (!host) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "Hermes hosts are not wired into this client",
		})
	}
	return host
}

/** The profile to act on: the body wins, then `?profile=`, then the default home. */
const profileOf = (fromBody: unknown, fromQuery: string | null | undefined): unknown =>
	fromBody ?? fromQuery ?? null

export const hermesRouter = {
	/**
	 * One profile's settings.
	 *
	 * An uninstalled Hermes answers 200 with `installed: false`; an unknown profile is a 404 and
	 * an invalid name a 400, because those are two different fixes for the operator.
	 */
	readSettings: authed
		.input(z.object({ profile: z.string().nullable().optional() }))
		.handler(async ({ input, context }) =>
			context.useCases.hermes.readSettings(
				profileOf(null, input.profile),
				hostOf(context.hermesHosts),
			),
		),

	writeSettings: authed
		.input(
			z.object({
				body: z.unknown(),
				/** `?profile=` — the screen links with it, the CLI posts it in the body. */
				profile: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const host = hostOf(context.hermesHosts)
			const body = (input.body ?? {}) as { profile?: unknown }
			return context.useCases.hermes.writeSettings(
				{ ...body, profile: profileOf(body.profile, input.profile) },
				host,
			)
		}),

	resetSettings: authed
		.input(
			z.object({
				body: z.unknown(),
				profile: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const host = hostOf(context.hermesHosts)
			const body = (input.body ?? {}) as { profile?: unknown }
			return context.useCases.hermes.resetSettings(
				{ profile: profileOf(body.profile, input.profile) },
				host,
			)
		}),
}
