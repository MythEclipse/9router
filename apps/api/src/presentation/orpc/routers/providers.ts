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
 * The remaining provider routes (models, overrides, test, test-models, test-batch,
 * validate, web-login, client, kilo, suggested-models) are *not* here yet. They are a
 * larger surface and several reach the network, so they are a separate step rather than a
 * half-populated namespace.
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
}

export type ProvidersRouter = typeof providersRouter
