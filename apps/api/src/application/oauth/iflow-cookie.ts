import {
	cookieForRequest,
	cookieForStorage,
	IFLOW_APIKEY_URL,
	IFLOW_BROWSER_HEADERS,
	iflowEnvelopeFailure,
	iflowKeyName,
	iflowRefreshedKey,
	maskedIflowKey,
	readIflowCookie,
} from "../../domain/iflow-cookie.ts"

/**
 * Connecting iFlow by trading a browser cookie for an API key.
 *
 * Two calls, and the order is not negotiable: the platform will only refresh a key whose
 * `name` you already know, so the key's name is read first and then handed back. A refresh
 * that produced no key is a failure even though the call succeeded — the connection would
 * have nothing to authenticate with.
 */

export interface IflowCookieDeps {
	readonly fetchImpl: typeof globalThis.fetch
	readonly createConnection: (input: Record<string, unknown>) => Promise<{
		id: string
		provider?: string
		email?: string
	}>
}

export interface IflowCookieAnswer {
	readonly ok: boolean
	readonly status: number
	readonly body: Record<string, unknown>
}

/**
 * `POST /api/oauth/iflow/cookie` — { cookie }.
 *
 * A refused cookie is the operator's to fix, so the platform's own status is passed through
 * rather than flattened to 500. The one thing never passed through is the cookie itself: it
 * stays in the request body and in this process.
 */
export async function importIflowCookie(
	body: unknown,
	deps: IflowCookieDeps,
): Promise<IflowCookieAnswer> {
	const parsed = readIflowCookie(body)
	if (!parsed.ok || !parsed.cookie) {
		return { ok: false, status: 400, body: { error: parsed.error } }
	}

	const cookie = cookieForRequest(parsed.cookie)

	try {
		const name = await readKeyName(cookie, deps)
		if (typeof name !== "string") return name

		const refreshed = await refreshKey(cookie, name, deps)
		if ("ok" in refreshed) return refreshed

		const connection = await deps.createConnection({
			provider: "iflow",
			authType: "cookie",
			name: refreshed.name || name,
			email: refreshed.name || name,
			apiKey: refreshed.apiKey,
			providerSpecificData: {
				cookie: cookieForStorage(cookie),
				expireTime: refreshed.expireTime,
			},
			testStatus: "active",
			isActive: true,
		})

		return {
			ok: true,
			status: 200,
			body: {
				success: true,
				connection: {
					id: connection.id,
					provider: connection.provider,
					email: connection.email,
					apiKey: maskedIflowKey(refreshed.apiKey),
					expireTime: refreshed.expireTime,
				},
			},
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error"
		return { ok: false, status: 500, body: { error: message } }
	}
}

/** Asks the platform what the key is called. Answers a name or a finished failure. */
async function readKeyName(cookie: string, deps: IflowCookieDeps) {
	const response = await deps.fetchImpl(IFLOW_APIKEY_URL, {
		method: "GET",
		headers: { ...IFLOW_BROWSER_HEADERS, Cookie: cookie },
	})

	if (!response.ok) {
		return {
			ok: false as const,
			status: response.status,
			body: { error: `Failed to fetch API key info: ${await response.text()}` },
		}
	}

	const raw = await response.json()
	const failure = iflowEnvelopeFailure(raw)
	if (failure !== null) {
		return { ok: false as const, status: 400, body: { error: `API key fetch failed: ${failure}` } }
	}

	const name = iflowKeyName((raw as { data?: unknown }).data)
	if (!name) {
		return {
			ok: false as const,
			status: 400,
			body: { error: "Missing name in API key info" },
		}
	}
	return name
}

/** Trades the cookie for a fresh key. Answers the key or a finished failure. */
async function refreshKey(cookie: string, name: string, deps: IflowCookieDeps) {
	const response = await deps.fetchImpl(IFLOW_APIKEY_URL, {
		method: "POST",
		headers: {
			...IFLOW_BROWSER_HEADERS,
			Cookie: cookie,
			"Content-Type": "application/json",
			Origin: "https://platform.iflow.cn",
			Referer: "https://platform.iflow.cn/",
		},
		body: JSON.stringify({ name }),
	})

	if (!response.ok) {
		return {
			ok: false as const,
			status: response.status,
			body: { error: `Failed to refresh API key: ${await response.text()}` },
		}
	}

	const raw = await response.json()
	const failure = iflowEnvelopeFailure(raw)
	if (failure !== null) {
		return {
			ok: false as const,
			status: 400,
			body: { error: `API key refresh failed: ${failure}` },
		}
	}

	const refreshed = iflowRefreshedKey((raw as { data?: unknown }).data)
	if (!refreshed.apiKey) {
		return {
			ok: false as const,
			status: 400,
			body: { error: "Missing API key in response" },
		}
	}
	return refreshed
}
