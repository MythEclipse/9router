/**
 * Proxy-pool procedures.
 *
 * These nine routes already delegated to use-cases, but only in-process: nothing in
 * `presentation/orpc` named a pool, so a caller outside this Next.js app had no way to read
 * one. The procedures below expose the use-cases oRPC already had wired.
 *
 * Three answers are shaped by the route rather than the use-case, and the reason is HTTP:
 *
 * - `create` and `deploy` are 201. oRPC carries data, not status codes, so the route supplies
 *   the number and this file supplies the shape.
 * - `bulkRemove` reports `missing` alongside `deleted`: an id that never existed is not an
 *   error, because the caller asked for it to be gone and it is. The page needs both lists to
 *   say what happened.
 * - A pool a connection still points at refuses removal with `PoolInUseError`, which carries
 *   the count. The boundary maps that to 409; here it stays a throw.
 *
 * `deploy` takes all four providers through one procedure with a validated enum, because
 * `RELAY_CONTRACTS` already treats them as one shape. Four procedures would be four copies of
 * the same handler and a fifth place to add the next provider.
 */
import { z } from "zod"
import { RELAY_PROVIDERS } from "../../../domain/relay-deploy.ts"
import { authed } from "../base.ts"

const Id = z.object({ id: z.string().min(1) })

/** A pool body: the fields are the use-case's business, so they stay open here. */
const PoolBody = z.record(z.string(), z.unknown())

/**
 * A list query, carried as flat keys.
 *
 * The use-case takes `URLSearchParams` because that is what the route had. Repeated keys
 * (`?provider=a&provider=b`) cannot survive a `z.record`, so the caller sends one value per
 * key; multiplicity is the use-case's to reject, not this file's to silently drop.
 */
const ListQuery = z.record(z.string(), z.string()).optional()

const queryOf = (pairs: Record<string, string | undefined> | undefined): URLSearchParams => {
	const query = new URLSearchParams()
	for (const [key, value] of Object.entries(pairs ?? {})) {
		if (value !== undefined) query.set(key, value)
	}
	return query
}

export const proxyPoolsRouter = {
	/** Every pool, optionally filtered, with the usage counts the screen shows. */
	list: authed
		.input(ListQuery)
		.handler(async ({ input, context }) => context.useCases.proxyPools.list(queryOf(input))),

	create: authed
		.input(PoolBody)
		.handler(async ({ input, context }) => context.useCases.proxyPools.create(input)),

	read: authed
		.input(Id)
		.handler(async ({ input, context }) => context.useCases.proxyPools.read(input.id)),

	/** Only the fields that were sent are touched; the use-case owns which ones may be. */
	update: authed
		.input(z.object({ id: z.string().min(1), patch: PoolBody }))
		.handler(async ({ input, context }) => context.useCases.proxyPools.update(input.id, input.patch)),

	/**
	 * Remove one pool. A pool still serving a connection throws `PoolInUseError`; the route
	 * turns that into a 409 so the screen can name what is in the way.
	 */
	remove: authed
		.input(Id)
		.handler(async ({ input, context }) => context.useCases.proxyPools.remove(input.id)),

	/** `{ ids }` or `{ all: true }`, in one statement and one transaction. */
	bulkRemove: authed
		.input(z.object({ ids: z.array(z.string()).optional(), all: z.boolean().optional() }))
		.handler(async ({ input, context }) => context.useCases.proxyPools.bulkRemove(input)),

	/**
	 * Prove the egress path works and record the result. This writes back: a failing pool
	 * becomes inactive so the router stops retrying a known-broken path.
	 */
	test: authed
		.input(Id)
		.handler(async ({ input, context }) => context.useCases.proxyPools.test(input.id)),

	/** Deploy a relay and register the result as a pool. Four providers, one shape. */
	deploy: authed
		.input(z.object({ provider: z.enum(RELAY_PROVIDERS), body: PoolBody }))
		.handler(async ({ input, context }) =>
			context.useCases.proxyPools.deploy(input.provider, input.body),
		),

	/** Server-side bulk import: accepted, then polled. The browser may close. */
	importJobs: {
		start: authed
			.input(PoolBody)
			.handler(async ({ input, context }) => context.useCases.proxyPools.importJobs.start(input)),

		/** One job by `?id=`, else the recent page. */
		read: authed
			.input(ListQuery)
			.handler(async ({ input, context }) =>
				context.useCases.proxyPools.importJobs.read(queryOf(input)),
			),

		cancel: authed
			.input(z.object({ id: z.string().min(1) }))
			.handler(async ({ input, context }) =>
				context.useCases.proxyPools.importJobs.cancel(queryOf(input)),
			),
	},
}
