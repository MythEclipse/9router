/**
 * Connection (provider) procedures — the core CRUD the dashboard's provider list uses.
 *
 * Thin by construction: validate (schema), delegate (use-case), return. No rule and no
 * database call lives here, so the REST route and this router cannot drift apart.
 *
 * `list` and `get` take no caller argument on purpose, and that is worth stating because
 * `usage` and `dashboard-keys` both got it wrong: `connections.list()` returns every
 * connection with secrets stripped by the use-case's own `toResponse`, so there is no
 * per-caller narrowing to preserve. If a key-scoped view is ever added, it belongs in the
 * use-case and this router must pass the caller — not a literal.
 *
 * The remaining provider surface is now here too: `models`, `test`, `testModels`,
 * `overrides`, `clientList`, `freeModels`, `suggestModels`, `testBatch`, `validate` and
 * the four `webLogin` procedures.
 *
 * Two of these deserve a note.
 *
 * `models` reaches a provider over the network, and its refusals carry the provider's own
 * status — a 429 must arrive as a 429 so the panel can say "try again later". That works
 * because `ProviderRefusal` extends `AppError` and `toORPCError` lets a carried `status`
 * win over the code's default. If a future use-case here throws a bare `Error`, the
 * status is lost and the dashboard sees a 500; translate it before adding it.
 *
 * `webLogin.begin` opens a headed browser on the host. It is behind the password session
 * like the rest of this namespace, and it is *not* something the API-key transport should
 * ever reach — the guard denies `/api/*` by default and `/api/providers/web-login` is not
 * on its allow-list.
 */
import { z } from "zod"
import { authed } from "../base.ts"

const ConnectionId = z.object({ id: z.string().min(1) })

/**
 * A connection body. Untyped by design at this layer: `connections.create` and `update`
 * read the fields they accept and ignore the rest, and duplicating that list as a schema
 * here would create a second place for it to fall out of date. Validation of what a
 * provider field means lives in the use-case and the domain.
 */
const ConnectionBody = z.record(z.string(), z.unknown())

/**
 * The paging and filter query the usage panel sends. Strings, not numbers: the query
 * string is where they come from, and the domain's paging rule decides what an
 * unparseable or out-of-range value means — duplicating that here would be a second
 * opinion.
 */
const ClientListingQuery = z
	.object({
		provider: z.string().nullish(),
		accountStatus: z.string().nullish(),
		sort: z.string().nullish(),
		page: z.string().nullish(),
		pageSize: z.string().nullish(),
	})
	.optional()

export const providersRouter = {
	/** Every connection, secrets stripped, compatible ones named after their node. */
	list: authed.handler(async ({ context }) => context.useCases.connections.list()),

	/** One connection, secret stripped. */
	get: authed
		.input(ConnectionId)
		.handler(async ({ input, context }) => context.useCases.connections.get(input.id)),

	/** Create a connection (API key only; OAuth has its own flow). */
	create: authed
		.input(ConnectionBody)
		.handler(async ({ input, context }) => context.useCases.connections.create(input)),

	/** Every field optional; absent means "leave it alone", including proxy and pool. */
	update: authed
		.input(z.object({ id: z.string().min(1), changes: ConnectionBody }))
		.handler(async ({ input, context }) =>
			context.useCases.connections.update(input.id, input.changes),
		),

	remove: authed
		.input(ConnectionId)
		.handler(async ({ input, context }) => context.useCases.connections.remove(input.id)),

	/** Ask the provider what models it offers. Refusals carry the provider's own status. */
	models: authed
		.input(ConnectionId)
		.handler(async ({ input, context }) => context.useCases.listProviderModels.run(input.id)),

	/** Probe one connection. A missing connection is a 404, not a failed probe. */
	test: authed
		.input(ConnectionId)
		.handler(async ({ input, context }) => context.useCases.checkConnection.run(input.id)),

	/** Probe every model this connection can reach. */
	testModels: authed
		.input(ConnectionId)
		.handler(async ({ input, context }) => context.useCases.probeModels.run(input.id)),

	overrides: {
		/** This provider's header override, plus the headers its transport already sends. */
		get: authed
			.input(ConnectionId)
			.handler(async ({ input, context }) => context.useCases.overrides.get(input.id)),

		/** Body: `{ headers: {name: value} }`. An empty payload clears the override. */
		set: authed
			.input(z.object({ id: z.string().min(1), headers: z.unknown().optional() }))
			.handler(async ({ input, context }) =>
				context.useCases.overrides.set(input.id, { headers: input.headers }),
			),
	},

	/** The connection listing the usage panel reads, with its disclosure whitelist. */
	clientList: authed
		.input(ClientListingQuery)
		.handler(async ({ input, context }) => context.useCases.listClientConnections.run(input)),

	/** Kilo's free tier: cached for an hour, served stale rather than empty. */
	freeModels: authed.handler(async ({ context }) => context.useCases.freeModels.list()),

	/** The model picker's suggestions for one provider URL. */
	suggestModels: authed
		.input(z.object({ url: z.string().nullish(), type: z.string().nullish() }).optional())
		.handler(async ({ input, context }) => context.useCases.suggestModels.run(input ?? {})),

	/**
	 * Probe every active connection in a group.
	 *
	 * `mode` is typed but not enumerated: an empty or unknown mode must reach
	 * `test-connections.ts`, whose message names the modes that are supported. An enum
	 * here would replace that with "invalid input" and teach the caller nothing.
	 */
	testBatch: authed
		.input(z.object({ mode: z.string(), providerId: z.string().optional() }))
		.handler(async ({ input, context }) => context.useCases.testConnections.run(input)),

	/** Ask the provider whether a pasted key works, before storing it. */
	validate: authed
		.input(ConnectionBody.optional())
		.handler(async ({ input, context }) => context.useCases.validateCredential.run(input ?? {})),

	webLogin: {
		/** Supported providers and saved profiles when no provider is named. */
		available: authed.handler(async ({ context }) => context.useCases.webLogin.available()),

		status: authed
			.input(z.object({ provider: z.string().min(1) }))
			.handler(async ({ input, context }) => context.useCases.webLogin.status(input.provider)),

		begin: authed
			.input(ConnectionBody.optional())
			.handler(async ({ input, context }) => context.useCases.webLogin.begin(input ?? {})),

		abandon: authed
			.input(z.object({ provider: z.string().nullish() }))
			.handler(async ({ input, context }) =>
				context.useCases.webLogin.abandon(input.provider ?? null),
			),
	},
}

export type ProvidersRouter = typeof providersRouter
