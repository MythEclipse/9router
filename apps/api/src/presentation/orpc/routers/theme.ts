/**
 * Theme procedures.
 *
 * `get` is `base`, not `authed`, because the REST route is public on purpose:
 * `ThemeProvider` applies the theme before anyone signs in, and the login page is the
 * one screen a signed-out user ever sees. Requiring a session here would have made
 * the theme fail to load exactly where it matters most.
 *
 * `set` is authenticated, and reads the role from the session rather than from the
 * input. It used to take `input.role`, justified by "the dashboard role is only
 * present in the Next cookie, so the route passes it through explicitly" — true
 * before `SessionClaims` carried `role`, and false now. A caller that states its own
 * role is not authenticated as that role: `refuseThemeWrite` refuses only an empty
 * role and `"apikey"`, so passing it through let an API-key session write the
 * site-wide theme by sending `role: "admin"`.
 */
import { z } from "zod"
import { authed, base } from "../base.ts"

const SetThemeInput = z
	.object({
		theme: z.unknown().optional(),
	})
	.optional()

export const themeRouter = {
	/** Public: the login page needs it before a session exists. */
	get: base.handler(async ({ context }) => context.useCases.getTheme()),

	set: authed.input(SetThemeInput).handler(async ({ input, context }) => {
		// The session's role, never the request's. A key session therefore arrives as
		// `"apikey"` and `refuseThemeWrite` refuses it, as the rule intends.
		const role = typeof context.session.role === "string" ? context.session.role : null
		return context.useCases.setTheme({ role }, input?.theme)
	}),
}
