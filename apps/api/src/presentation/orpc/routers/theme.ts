/**
 * Theme procedures.
 *
 * `get` is public at the REST layer — the login page applies the theme before
 * anyone has a session. `set` here is the authenticated path; the dashboard
 * role (which can distinguish a password sign-in from a key) is only present in
 * the Next cookie, so the route passes it through explicitly.
 */
import { z } from "zod"
import { authed } from "../base.ts"

const SetThemeInput = z
	.object({
		theme: z.unknown().optional(),
		/** Only the REST route can supply this; oRPC sessions carry no role. */
		role: z.string().nullable().optional(),
	})
	.optional()

export const themeRouter = {
	get: authed.handler(async ({ context }) => context.useCases.getTheme()),

	set: authed.input(SetThemeInput).handler(async ({ input, context }) => {
		return context.useCases.setTheme({ role: input?.role ?? null }, input?.theme)
	}),
}
