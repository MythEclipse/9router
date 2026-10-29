import type {
	ProxyPoolDeps,
	StoredPool,
} from "9router-api/application/proxy-pools/manage-proxy-pools"
import { usesRelay } from "9router-api/domain/proxy-pool"
import { fetch as undiciFetch } from "undici"
import { isSupportedProxyScheme } from "@/lib/network/outboundProxy"
import { testProxyUrl } from "@/lib/network/proxyTest"
import {
	createProxyPool as createPool,
	deleteProxyPool as deletePool,
	deleteProxyPools as deletePools,
	getProviderConnections,
	getProxyPoolById,
	getProxyPools,
	updateProxyPool as updatePool,
} from "@/models"

/**
 * The pool store, the connection store, and the two ways to probe an egress path.
 *
 * The relay probe lives here because it needs a transport: a deployed relay has no proxy
 * URL to dial, so proving it works means asking *it* to fetch something.
 */
const RELAY_TARGET = "https://httpbin.org"
const RELAY_TIMEOUT_MS = 10_000

interface RelayProbe {
	ok: boolean
	status: number
	statusText?: string
	elapsedMs: number
	error?: string
}

async function probeRelay(relayUrl: string): Promise<RelayProbe> {
	const controller = new AbortController()
	const startedAt = Date.now()
	const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS)
	try {
		const res = await undiciFetch(relayUrl, {
			method: "GET",
			headers: { "x-relay-target": RELAY_TARGET, "x-relay-path": "/get" },
			signal: controller.signal,
		})
		return {
			ok: res.ok,
			status: res.status,
			statusText: res.statusText,
			elapsedMs: Date.now() - startedAt,
		}
	} catch (error) {
		return {
			ok: false,
			status: 500,
			elapsedMs: Date.now() - startedAt,
			error:
				error instanceof Error && error.name === "AbortError"
					? "Relay test timed out"
					: error instanceof Error
						? error.message
						: String(error),
		}
	} finally {
		clearTimeout(timer)
	}
}

/**
 * The pool row, narrowed to the fields the use-case declares.
 *
 * The store's type is wider — it carries `testStatus`, timestamps, and columns these
 * selectors do not name — so the coercion happens once, here.
 */
function narrowPool(pool: Record<string, unknown>): StoredPool {
	return {
		id: String(pool.id),
		type: typeof pool.type === "string" ? pool.type : "http",
		proxyUrl: typeof pool.proxyUrl === "string" ? pool.proxyUrl : "",
		name: pool.name == null ? null : String(pool.name),
		noProxy: pool.noProxy == null ? null : String(pool.noProxy),
		isActive: pool.isActive === true,
		strictProxy: pool.strictProxy === true,
	}
}

export function createProxyPoolDeps(): ProxyPoolDeps {
	return {
		exists: async (id) => Boolean(await getProxyPoolById(id)),

		list: async (filter) => {
			const pools = await getProxyPools(filter)
			return pools.map(narrowPool)
		},

		findById: async (id) => {
			const pool = await getProxyPoolById(id)
			return pool ? narrowPool(pool) : null
		},

		create: async (input) => narrowPool(await createPool(input)),

		update: async (id, patch) => narrowPool(await updatePool(id, patch)),

		remove: async (id) => {
			await deletePool(id)
		},

		removeMany: async (ids) => {
			const removed = await deletePools(ids)
			return removed.map(narrowPool)
		},

		boundConnections: async () => await getProviderConnections(),

		supportedScheme: isSupportedProxyScheme,

		/**
		 * Probe the pool's own egress path, by the method its type dictates.
		 *
		 * A relay pool stores the deployment's URL rather than a proxy URL, so dialling it
		 * as an HTTP proxy would fail for every healthy relay.
		 */
		probe: async (pool) => {
			if (usesRelay(pool.type)) return probeRelay(pool.proxyUrl)
			const result = await testProxyUrl({ proxyUrl: pool.proxyUrl })
			return {
				ok: result?.ok === true,
				status: typeof result?.status === "number" ? result.status : null,
				statusText: result?.statusText ?? null,
				error: result?.error ?? null,
				elapsedMs: result?.elapsedMs ?? null,
			}
		},
	}
}

/**
 * The pool store as `ConnectionHost.pools` wants it.
 *
 * The same object `createProxyPoolDeps` builds: the pool CRUD and the provider
 * create-path's `exists` check must not hold two views of the same table.
 */
export const proxyPoolHost = createProxyPoolDeps()
