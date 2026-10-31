/**
 * Settings procedures.
 *
 * `loginGate` is public. It is the question the login screen asks before it knows who the
 * caller is ("does this install need a password?"), so putting it behind auth would make
 * the login page unable to render. It is also the only `base` procedure in this namespace:
 * the guard's allow-list names `/api/settings/require-login` and nothing else here.
 *
 * **The role is passed in, not decided here.** `settings.write`, `settingsHistory.list`,
 * `settingsHistory.read` and `settingsHistory.revert` all branch on whether the caller is
 * an API-key session, and the rule about what a role may do belongs beside the list of
 * site-wide settings rather than in a transport. Each of those hands the session's role
 * down and lets the use-case refuse; a check repeated here would be a second opinion that
 * can drift.
 *
 * **Database credentials come off the request headers, never off the input.** The CLI has
 * no cookie, and a poll during an import must keep working while the password row is being
 * replaced, so those endpoints prove identity with `x-9r-cli-token` / `x-9r-password` /
 * `x-9r-poll-token`. Accepting them as procedure input would let any caller assert
 * `{ cli: true }` and satisfy the rules with a claim instead of a proof — so only the query
 * string and the body travel as input.
 */
import { z } from "zod"
import { credentialsFrom } from "../../../application/settings/manage-database.ts"
import { authed, base } from "../base.ts"
import { LoginGateSchema } from "../schemas.ts"

/** The role the settings rules branch on; `null` when the session carries none. */
function roleOf(session: { readonly role?: string | null }): string | null {
	return typeof session.role === "string" ? session.role : null
}

/**
 * The body of a settings write.
 *
 * Passed through as sent: which keys are site-wide, and which values are secrets to strip,
 * are the use-case's business. Narrowing here would answer "invalid input" where the
 * use-case answers which key it refused and why.
 */
const SettingsBody = z.record(z.string(), z.unknown())

export const settingsRouter = {
	loginGate: base.output(LoginGateSchema).handler(async ({ context }) => {
		const { gate, degraded } = await context.useCases.getLoginGate()
		return { ...gate, degraded }
	}),

	/** Every setting, minus the secrets. */
	read: authed.handler(async ({ context }) => context.useCases.settings.read()),

	/**
	 * The routing configuration as a document a human reviews in a diff.
	 *
	 * Credentials are replaced inside the domain rule (`domain/config-export.ts`), so the
	 * transport cannot forget to strip one — every export passes through that function.
	 */
	exportConfig: authed.handler(async ({ context }) => context.useCases.configExport.export()),

	/** Merge a change into the settings row. `PUT` and `PATCH` are the same operation. */
	write: authed
		.input(SettingsBody)
		.handler(async ({ input, context }) =>
			context.useCases.settings.write({ body: input, role: roleOf(context.session) }),
		),

	history: {
		/** The before-images of the last settings mutations. */
		list: authed.handler(async ({ context }) =>
			context.useCases.settingsHistory.list({ role: roleOf(context.session) }),
		),

		/**
		 * One entry in full, so a revert can be previewed. A read that travels as a POST
		 * because the id stays out of the URL and the answer carries a whole configuration.
		 */
		read: authed
			.input(z.object({ id: z.string() }))
			.handler(async ({ input, context }) =>
				context.useCases.settingsHistory.read({ id: input.id, role: roleOf(context.session) }),
			),

		/** Re-apply a snapshot. `keys` limits the revert to a subset of it. */
		revert: authed
			.input(z.object({ id: z.string(), keys: z.unknown().optional() }))
			.handler(async ({ input, context }) => ({
				ok: true,
				...(await context.useCases.settingsHistory.revert({
					id: input.id,
					keys: input.keys,
					role: roleOf(context.session),
				})),
			})),
	},

	autoBackup: {
		/** Re-arms a scheduler that a restart killed; see the use-case for why. */
		read: authed.handler(async ({ context }) => context.useCases.autoBackup.read()),

		write: authed
			.input(SettingsBody)
			.handler(async ({ input, context }) => context.useCases.autoBackup.write(input)),

		/**
		 * Body: `{ action: "test", password }`. A failed send still answers 200 with
		 * `ok: false`, so the screen can show the provider's own message instead of the
		 * generic one a 5xx would produce.
		 */
		sendNow: authed
			.input(z.object({ action: z.unknown().optional(), password: z.string().nullish() }))
			.handler(async ({ input, context }) =>
				context.useCases.autoBackup.sendNow({
					action: input.action,
					password: typeof input.password === "string" ? input.password : null,
				}),
			),
	},

	database: {
		/**
		 * The whole install, or `?summary=true` for the summary the login screen reads.
		 *
		 * `searchParams` is the raw query string: `summary`, `sections` and the rest are
		 * parsed by the rule that knows what they mean, so a second reading here would be
		 * a second parser.
		 */
		read: authed
			.input(z.object({ searchParams: z.string().default("") }))
			.handler(async ({ input, context }) =>
				context.useCases.database.read({
					searchParams: new URLSearchParams(input.searchParams),
					credentials: credentialsFrom(context.headers),
					contentLength: context.headers.get("content-length"),
				}),
			),

		/** Replace the install, synchronously. */
		write: authed.input(SettingsBody).handler(async ({ input, context }) =>
			context.useCases.database.write({
				body: input,
				credentials: credentialsFrom(context.headers),
			}),
		),

		/** Replace it in the background; answers a poll token, not a password. */
		startJob: authed.input(SettingsBody).handler(async ({ input, context }) =>
			context.useCases.database.startJob({
				body: input,
				credentials: credentialsFrom(context.headers),
				contentLength: context.headers.get("content-length"),
			}),
		),

		/**
		 * How far the restore has got. The poll token is checked before the password,
		 * because mid-import the password is compared against the row being replaced.
		 */
		readJob: authed
			.input(z.object({ jobId: z.string().min(1) }))
			.handler(async ({ input, context }) =>
				context.useCases.database.readJob({
					jobId: input.jobId,
					credentials: credentialsFrom(context.headers),
				}),
			),
	},
}
