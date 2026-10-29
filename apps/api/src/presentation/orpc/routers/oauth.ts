/**
 * OAuth and credential-import procedures.
 *
 * Two families live here, and the split is not cosmetic.
 *
 * **`credentials.*`** stores a credential the operator already holds — a token, an API
 * key, a bulk paste, or one found on disk by an auto-import. They answer
 * `{ ok, status, error }` rather than throwing, because the status is the *provider's*
 * (401 for a refused token, 409 for a key Kiro already has, 502 for an unreachable
 * upstream). `orRefuse` turns those into `AppError`s that carry the number, so the panel
 * keeps saying what the provider said instead of "internal error".
 *
 * **`login.*`** drives a login that is still in flight: the session the browser polls, the
 * proxy carrying the callback, the social exchange. None of these paths is on
 * `PUBLIC_API_PATHS`, so all of them stay behind the password session.
 *
 * **Two login steps are deliberately absent.** `start-proxy`, `authorize`, `device-code`,
 * `register-session`, `exchange`, `poll` and `manual-code` still call the provider layer
 * from the route: they mint in-memory sessions and, for MiMo, set an httpOnly cookie the
 * browser has to receive. A cookie is not a value a procedure may return, and turning
 * `beginSession` into procedure input would put a credential on the caller's side of the
 * boundary — the same mistake the database routes avoid with headers. They stay host-side
 * until they have a port that returns the cookie as transport state rather than data.
 *
 * `createProviderConnection` is *not* a procedure input. The routes used to hand it in as
 * a dependency; that put a database write on the caller's side of the boundary, where a
 * different route could pass a different implementation.
 */
import { z } from "zod"
import { authed } from "../base.ts"
import { orRefuse } from "../refusal.ts"

/**
 * An imported credential body.
 *
 * Untyped on purpose, like `connections.create`: each provider reads the fields it needs
 * and the use-case names the one it is missing ("API key is required"). A schema here
 * would answer "invalid input" and lose that message — the same trap that cost six routes
 * their 400s when `models` was migrated.
 */
const ImportBody = z.unknown()

/** A provider id, for the procedures that are generic over the importer. */
const ProviderId = z.string().min(1)

export const oauthRouter = {
	/** Importing a credential the operator already holds, dispatched by provider. */
	importToken: authed
		.input(z.object({ provider: ProviderId, body: ImportBody }))
		.handler(async ({ input, context }) =>
			orRefuse(await context.useCases.credentials.importToken(input.provider, input.body)),
		),

	/** A long-lived key: Kiro's bearer key, or MiMo's key-or-session. */
	importApiKey: authed
		.input(z.object({ provider: ProviderId, body: ImportBody }))
		.handler(async ({ input, context }) =>
			orRefuse(await context.useCases.credentials.importApiKey(input.provider, input.body)),
		),

	/** Several credentials pasted at once. Answers counts; a partial success is not an error. */
	importBatch: authed
		.input(z.object({ provider: ProviderId, body: ImportBody }))
		.handler(async ({ input, context }) => context.useCases.credentials.importBatch(input)),

	/**
	 * Read a credential from the machine's own config (Kiro, Zed, MiMo).
	 *
	 * `{ found, error }` is not a refusal: "no credential on this machine" is the expected
	 * answer on a fresh install, so it travels as a 200 with `found: false` and the screen
	 * offers the paste box instead.
	 */
	autoImport: authed
		.input(z.object({ provider: ProviderId }))
		.handler(async ({ input, context }) => context.useCases.credentials.autoImport(input.provider)),

	/** Cursor's own credential store, which has its own shape and its own answer. */
	cursorAutoImport: authed.handler(async ({ context }) =>
		context.useCases.credentials.autoImportCursor(),
	),

	/** A GitLab personal access token, checked against the instance before storing. */
	gitlabPat: authed
		.input(z.object({ token: z.string().min(1), baseUrl: z.string().optional() }))
		.handler(async ({ input, context }) =>
			orRefuse(await context.useCases.oauth.importGitlabPat(input, context.headers)),
		),

	/** An iflow session cookie, checked against the platform before storing. */
	iflowCookie: authed
		.input(z.object({ cookie: z.string().min(1) }))
		.handler(async ({ input, context }) =>
			orRefuse(await context.useCases.oauth.importIflowCookie(input, context.headers)),
		),

	/**
	 * A login that has not finished yet — a lookup keyed by `provider`, plus the `state`
	 * the browser was given. `state` is nullish because a device-code flow has no session
	 * to name.
	 */
	login: {
		/** How a browser-side login stands. */
		status: authed
			.input(z.object({ provider: ProviderId, state: z.string().nullish() }))
			.handler(async ({ input, context }) =>
				orRefuse(await context.useCases.oauth.pollSession(input.provider, input.state ?? null)),
			),

		/** Stop the local callback proxy a login started. */
		stopProxy: authed
			.input(z.object({ provider: ProviderId }))
			.handler(async ({ input, context }) =>
				orRefuse(context.useCases.oauth.stopProxy(input.provider)),
			),

		/** Whether the provider's own IDE is installed and signed in, where that applies. */
		ideStatus: authed
			.input(z.object({ provider: ProviderId }))
			.handler(async ({ input, context }) =>
				orRefuse(await context.useCases.oauth.ideStatus(input.provider)),
			),

		/** Which region a MiMo login would use, before it is started. */
		mimoRegion: authed
			.input(ImportBody)
			.handler(async ({ input, context }) => context.useCases.oauth.readMimoRegion(input)),
	},

	/** Kiro's social sign-in: two calls, because the user leaves the page between them. */
	kiroSocial: {
		authorize: authed
			.input(z.object({ provider: z.string().nullish() }))
			.handler(async ({ input, context }) =>
				orRefuse(context.useCases.oauth.authorizeKiroSocial(input.provider ?? null)),
			),

		exchange: authed
			.input(ImportBody)
			.handler(async ({ input, context }) =>
				orRefuse(await context.useCases.oauth.exchangeKiroSocial(input)),
			),
	},
}

export type OAuthRouter = typeof oauthRouter
