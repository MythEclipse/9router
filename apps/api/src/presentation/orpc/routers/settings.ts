/**
 * Settings procedures.
 *
 * `loginGate` is public. It is the question the login screen asks before it
 * knows who the caller is ("does this install need a password?"), so putting it
 * behind auth would make the login page unable to render.
 *
 * Everything else under settings mutates configuration and belongs behind
 * `authed`; those procedures land here as they are ported.
 */
import { base } from "../base.ts"
import { LoginGateSchema } from "../schemas.ts"

export const settingsRouter = {
	loginGate: base.output(LoginGateSchema).handler(async ({ context }) => {
		const { gate, degraded } = await context.useCases.getLoginGate()
		return { ...gate, degraded }
	}),
}
