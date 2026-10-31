/**
 * A dashboard session built from an API key, for machine callers.
 *
 * Every `/api/*` route authenticates with the `auth_token` cookie, which a scraper cannot
 * carry: Prometheus sends `Authorization: Bearer …` and nothing else. Publishing the scrape
 * under `/v1/*` would reuse the gateway's key check, but `/v1` is the OpenAI-compatible
 * surface — a metrics document there is not an inference call, and clients that enumerate
 * `/v1/models` would start finding endpoints that answer in Prometheus text.
 *
 * So the key becomes a session here, with exactly the claims an API-key login produces
 * (`role: "apikey"`, `apiKey`, `allowedModels`), which means the scope rules downstream —
 * `usageScopeOf`, the allow-list, the per-key filter — apply unchanged. A bearer therefore
 * sees the same numbers a key login would see, and cannot widen them.
 *
 * Four refusals, all of them fail-closed:
 *
 * - unknown key → no session;
 * - inactive key → no session (`isActive` is the same switch the gateway honours);
 * - expired key → no session, compared against `expiresAt` rather than trusted as a flag;
 * - a key without `viewUsage` → no session. `normalizePermissions` fills the default, so an
 *   explicit `false` is the only way to lose it, and losing it must actually deny.
 */
import { normalizePermissions } from "@9router/auth/dashboardPermissions"
import { getApiKeyByKey } from "@9router/db/repos/apiKeysRepo"
import type { DashboardSession } from "@/lib/orpcClient"

/** The key a machine caller presented, in the two spellings this gateway accepts. */
export function presentedApiKey(request: Request): string | null {
	const authorization = request.headers.get("authorization")
	if (authorization?.toLowerCase().startsWith("bearer ")) {
		const token = authorization.slice(7).trim()
		if (token) return token
	}
	const xApiKey = request.headers.get("x-api-key")?.trim()
	return xApiKey ? xApiKey : null
}

/**
 * The session a bearer key stands for, or `null` when it may not read usage.
 *
 * Shaped like the cookie an API-key login writes, including `userId`, because the routes
 * downstream read `userId` to decide whether a session exists at all.
 */
export async function bearerSession(request: Request): Promise<DashboardSession | null> {
	const key = presentedApiKey(request)
	if (!key) return null

	const record = await getApiKeyByKey(key)
	if (!record || !record.isActive) return null
	if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return null

	const permissions = normalizePermissions(record.permissions)
	if (permissions.viewUsage !== true) return null

	return {
		userId: record.id,
		email: record.name || record.id,
		role: "apikey",
		keyId: record.id,
		keyName: record.name || "API Key",
		apiKey: record.key,
		permissions,
		allowedModels: record.allowedModels || "*",
		allowedEndpoints: record.allowedEndpoints || [],
		tokenLimit: record.tokenLimit || 0,
	} as unknown as DashboardSession
}
