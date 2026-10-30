/**
 * The auth-status procedure.
 *
 * Deliberately open (`base`, not `authed`): this is the call that tells the client whether it is
 * signed in, so requiring a session first would make it unusable. Everything the answer contains
 * comes from the host through `authStatusPort`, and every rule about what the answer looks like
 * lives in `domain/auth-status.ts`.
 */
import { ORPCError } from "@orpc/server"
import { type AppContext, base } from "../base.ts"

type AuthStatusPort = NonNullable<AppContext["authStatusPort"]>

const portOf = (port: AuthStatusPort | undefined): AuthStatusPort => {
	if (!port) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "The auth-status port is not wired into this client",
		})
	}
	return port
}

export const authStatusRouter = {
	/** What this session is: role, permissions, where it belongs, how it signed in. */
	read: base.handler(async ({ context }) =>
		context.useCases.authStatus.read(portOf(context.authStatusPort)),
	),
}
