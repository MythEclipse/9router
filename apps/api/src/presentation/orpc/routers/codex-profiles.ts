/**
 * Codex profile procedures.
 *
 * Three procedures for three verbs on one directory. The rules are in `domain/codex-profiles`,
 * the decisions are in the use-case, and this file does the only thing left: turn "no host
 * access" into a 500 and hand the port across.
 *
 * `body: unknown` rather than a typed input, because the use-case's own validators are what
 * refuse a bad name or model — and they already have the operator-facing messages. A second
 * copy of those rules in Zod would drift from the one the TOML writer trusts.
 */
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import { authed } from "../base.ts"

type ProfilesHost = NonNullable<import("../base.ts").AppContext["codexProfilesHosts"]>

/** The port, or a refusal. No port means this build cannot reach a home directory. */
const portOf = (port: ProfilesHost | undefined): ProfilesHost => {
	if (!port) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "Codex profile hosts are not wired into this client",
		})
	}
	return port
}

export const codexProfilesRouter = {
	/** Every profile under `~/.codex`, sorted. A missing directory is an empty list. */
	list: authed.handler(async ({ context }) =>
		context.useCases.codexProfiles.list(portOf(context.codexProfilesHosts)),
	),

	/** Create or overwrite one profile. */
	write: authed
		.input(z.object({ body: z.unknown() }))
		.handler(async ({ input, context }) =>
			context.useCases.codexProfiles.write(input.body, portOf(context.codexProfilesHosts)),
		),

	/** Remove one profile; 404 when it was not there. */
	remove: authed
		.input(z.object({ body: z.unknown() }))
		.handler(async ({ input, context }) =>
			context.useCases.codexProfiles.remove(input.body, portOf(context.codexProfilesHosts)),
		),
}
