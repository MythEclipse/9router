/**
 * The Codex reset-credit procedures.
 *
 * The connection row, the proxy config, the OAuth refresh and the two upstream calls all come from
 * the host: `apps/api` cannot reach `open-sse` or the local database without a port. Every rule
 * about when a connection is eligible or a retry is worth making is in the domain, and the
 * sequence between them is in the use-case.
 */
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import { type AppContext, authed } from "../base.ts"

type CodexPort = NonNullable<AppContext["codexResetPort"]>

const portOf = (port: CodexPort | undefined): CodexPort => {
	if (!port) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "The Codex reset-credit port is not wired into this client",
		})
	}
	return port
}

const input = z.object({ connectionId: z.string() })

export const codexResetCreditsRouter = {
	/** What is left to redeem. */
	read: authed
		.input(input)
		.handler(async ({ input, context }) =>
			context.useCases.codexResetCredits.read(input.connectionId, portOf(context.codexResetPort)),
		),

	/** Redeem one. The redeem id is minted server-side so a client cannot replay one. */
	redeem: authed
		.input(input)
		.handler(async ({ input, context }) =>
			context.useCases.codexResetCredits.redeem(input.connectionId, portOf(context.codexResetPort)),
		),
}
