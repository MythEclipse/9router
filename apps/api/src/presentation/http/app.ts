/**
 * Hono app wiring the oRPC handler.
 *
 * Three details in here are easy to get wrong and expensive to debug:
 *
 * 1. `OpenAPIHandler` lives in `@orpc/openapi/fetch`, not `@orpc/server`.
 * 2. `handle()` returns `{ matched, response }`, NOT a `Response`. When nothing
 *    matched, `response` is `undefined` — returning it as-is throws inside Hono.
 * 3. `docsPath` defaults to "/", the same prefix REST procedures live under, so
 *    an explicit path is mandatory or the docs page shadows the API.
 */

import { OpenAPIHandler } from "@orpc/openapi/fetch"
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins"
import { ORPCError } from "@orpc/server"
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4"
import { Hono } from "hono"
import { cors } from "hono/cors"
import type { AppContext } from "../orpc/base.ts"
import { toORPCError } from "../orpc/error-mapping.ts"
import { appRouter } from "../orpc/router.ts"

export interface AppOptions {
	readonly webOrigin: string
}

export function createApp(options: AppOptions) {
	const apiHandler = new OpenAPIHandler(appRouter, {
		plugins: [
			new OpenAPIReferencePlugin({
				schemaConverters: [new ZodToJsonSchemaConverter()],
				docsPath: "/docs",
				specPath: "/spec.json",
			}),
		],
		interceptors: [
			async ({ next }) => {
				// One place turns AppError into a typed ORPCError for every route.
				// An ORPCError is already typed: `toORPCError` would relabel a
				// deliberate 401 as INTERNAL/500.
				try {
					return await next()
				} catch (error) {
					if (error instanceof ORPCError) throw error
					throw toORPCError(error)
				}
			},
		],
	})

	const app = new Hono<{ Variables: { context: AppContext } }>()

	app.use(
		"/api/*",
		cors({
			origin: options.webOrigin,
			credentials: true,
			allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
		}),
	)

	app.all("/api/*", async (c) => {
		// The context is passed as the Hono `env` third argument by main.ts (which
		// owns the use-cases), so this file never imports the database. Reading it
		// from `c.env` — not from a `c.set`/`c.get` round-trip, which silently
		// produced `undefined` and turned every authenticated call into a 401.
		const context = c.env as unknown as AppContext
		const { matched, response } = await apiHandler.handle(c.req.raw, {
			// The router is mounted under /api, so procedures resolve as
			// /api/system/health etc. Without `prefix` the handler matches on the
			// bare procedure path and every request falls through as unmatched.
			prefix: "/api",
			context,
		})
		// `matched: false` means no procedure claimed this path — let Hono 404 it
		// instead of handing an `undefined` response to the runtime.
		if (!matched || !response) {
			return c.json({ error: "Not found" }, 404)
		}
		return response
	})

	app.get("/health", (c) => c.json({ status: "ok" }))

	return { app, apiHandler }
}
