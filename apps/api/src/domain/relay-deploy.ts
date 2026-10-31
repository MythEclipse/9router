/**
 * Rules for deploying a relay and registering it as a proxy pool.
 *
 * Four providers (Vercel, Cloudflare, Deno, Netlify) take the same shape: a token, a
 * project name that defaults, a deployment that must become ready, and a pool created from
 * the deployment's URL. The provider APIs differ; these rules do not.
 */

/** The providers a relay can be deployed to. */
export const RELAY_PROVIDERS = ["vercel", "cloudflare", "deno", "netlify"] as const

export type RelayProvider = (typeof RELAY_PROVIDERS)[number]

/**
 * How a relay's own hop to the upstream is made.
 *
 * `https` uses the platform's client, which is cheap and carries nothing extra.
 * `wreq` runs an emulated TLS stack inside the function, so the upstream sees a
 * chosen fingerprint instead of the platform's - the difference between a relay
 * a fingerprinted provider accepts and one it refuses.
 */
export const RELAY_TRANSPORTS = ["https", "wreq"] as const

export type RelayTransport = (typeof RELAY_TRANSPORTS)[number]

/**
 * The transport a request asked for.
 *
 * Anything unrecognised falls back to `https` rather than failing the deploy: the
 * field is an optimisation, and a typo should not cost an operator their whole
 * request. The fallback is also the safe side - it is the transport that needs no
 * extra dependency at the provider.
 */
export function transportOf(raw: unknown): RelayTransport {
	return raw === "wreq" ? "wreq" : "https"
}

/** The longest a deployment may take before it is given up on, in milliseconds. */
export const DEPLOY_TIMEOUT_MS = 120_000

/** How often a deployment's readiness is checked, in milliseconds. */
export const DEPLOY_POLL_INTERVAL_MS = 3_000

/**
 * The project name to deploy under.
 *
 * The default is derived from the clock rather than random, so an operator reading the
 * provider's dashboard can tell two attempts apart by when they ran. A name that was sent
 * is trimmed; an empty one is not an error, because the field is optional and the
 * dashboard sends `""` when untouched.
 */
export function projectNameOf(raw: unknown, now: number): string {
	const sent = typeof raw === "string" ? raw.trim() : ""
	return sent || `relay-${now.toString(36)}`
}

/**
 * What each provider's deploy request must carry.
 *
 * The four dashboards do not agree on anything but the shape: the token field is named
 * after the provider (`vercelToken`, `apiToken`, `denoToken`, `netlifyToken`), and each
 * needs a different second field. Kept as data rather than four branches, because the
 * alternative is five places to edit for the fifth provider.
 */
export interface RelayContract {
	/** The request field that carries the token. */
	readonly tokenField: string
	/** The message shown when the token is blank. */
	readonly tokenMessage: string
	/** Fields the provider requires besides the token, with the message when blank. */
	readonly required: readonly { readonly field: string; readonly message: string }[]
	/**
	 * The hops this provider can carry, when it is more than one.
	 *
	 * Only Vercel has a choice: its function can run an emulated TLS stack, while
	 * Cloudflare and Deno offer no client socket and Netlify's function is Node
	 * with its own client. Absent means the platform's client and nothing else.
	 */
	readonly transports?: readonly RelayTransport[]
}

export const RELAY_CONTRACTS: Readonly<Record<RelayProvider, RelayContract>> = {
	vercel: {
		tokenField: "vercelToken",
		tokenMessage: "Vercel API token is required",
		required: [],
		transports: RELAY_TRANSPORTS,
	},
	cloudflare: {
		tokenField: "apiToken",
		tokenMessage: "API token is required",
		required: [{ field: "accountId", message: "Cloudflare Account ID is required" }],
	},
	deno: {
		tokenField: "denoToken",
		tokenMessage: "Deno Deploy API token is required",
		required: [{ field: "orgDomain", message: "Organization domain is required" }],
	},
	netlify: {
		tokenField: "netlifyToken",
		tokenMessage: "Netlify API token is required",
		required: [],
	},
}

/**
 * What a deploy request supplied, or the first thing it left blank.
 *
 * A blank token is refused *before* any provider call. The alternative is a request that
 * leaves the process, fails at the provider's edge, and reports the provider's wording —
 * "unauthorized" — for what is actually a form the operator left blank. The required
 * fields are checked first, matching the order the original screens reported them in.
 */
export function deployRequestOf(
	provider: RelayProvider,
	body: Record<string, unknown>,
): { token: string; fields: Record<string, string> } | { error: string } {
	const contract = RELAY_CONTRACTS[provider]
	const fields: Record<string, string> = {}
	for (const { field, message } of contract.required) {
		const value = typeof body[field] === "string" ? body[field].trim() : ""
		if (!value) return { error: message }
		fields[field] = value
	}

	const sent = body[contract.tokenField]
	const token = typeof sent === "string" ? sent.trim() : ""
	if (!token) return { error: contract.tokenMessage }
	// Carried only for providers that offer a choice, so `fields.transport` is
	// either a real selection or absent - never a silent default for a platform
	// that has no alternative.
	if (contract.transports) fields.transport = transportOf(body.transport)
	return { token, fields }
}

/**
 * The project name to deploy under, as the provider will accept it.
 *
 * Vercel, Cloudflare and Deno take the name as-is. Netlify turns it into a subdomain, so
 * anything that is not a lowercase alphanumeric or a hyphen becomes a hyphen — a name like
 * `Netlify-Relay!!` would otherwise be refused by the provider as an invalid site name.
 */
export function siteNameOf(provider: RelayProvider, raw: unknown, now: number): string {
	const projectName = projectNameOf(raw, now)
	if (provider !== "netlify") return projectName
	const cleaned = projectName
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
	return cleaned || `relay-${now.toString(36)}`
}

/** Whether a deployment's reported state means it is serving. */
export function deploymentReady(state: unknown): boolean {
	return state === "READY"
}

/**
 * Whether a deployment has failed for good.
 *
 * `ERROR` and `CANCELED` are terminal at every provider that reports them; polling past
 * them burns the whole timeout and then reports "timed out" for a deployment that failed
 * in its first second.
 */
export function deploymentFailed(state: unknown): boolean {
	return state === "ERROR" || state === "CANCELED"
}

/**
 * Whether the deployment poll should keep waiting.
 *
 * Both bounds are checked: elapsed time (the deployment is slow) and the terminal states
 * (the deployment has already decided).
 */
export function shouldKeepPolling(input: {
	readonly startedAt: number
	readonly now: number
	readonly state: unknown
	readonly timeoutMs?: number
}): boolean {
	if (deploymentReady(input.state) || deploymentFailed(input.state)) return false
	return input.now - input.startedAt < (input.timeoutMs ?? DEPLOY_TIMEOUT_MS)
}

/** The URL a deployed relay answers on. */
export function relayUrlOf(hostOrUrl: string): string {
	const trimmed = hostOrUrl.trim()
	if (/^https?:\/\//.test(trimmed)) return trimmed
	return `https://${trimmed}`
}

/** Where a Netlify relay answers: the site's address is only its root. */
export const NETLIFY_FUNCTION_PATH = "/.netlify/functions/relay"

/**
 * The address the pool should call for a given provider.
 *
 * Vercel, Cloudflare and Deno serve the relay at the deployment's root. Netlify serves it
 * as a function under a fixed path, so a pool pointed at the site root would reach the
 * placeholder page instead of the relay — every request through it would fail while the
 * deployment itself looked healthy.
 */
export function relayEndpointOf(provider: RelayProvider, deploymentUrl: string): string {
	const normalized = relayUrlOf(deploymentUrl)
	if (provider !== "netlify") return normalized
	if (normalized.endsWith(NETLIFY_FUNCTION_PATH)) return normalized
	return `${normalized.replace(/\/$/, "")}${NETLIFY_FUNCTION_PATH}`
}

/**
 * The pool a successful deployment registers.
 *
 * `type` is the provider, because the test path reads it to decide *how* to probe: a relay
 * is tested by asking it to fetch something, an `http` pool by dialling it as a proxy.
 * Registering a relay as `http` would make its own test fail.
 */
export function deployedPoolOf(input: {
	readonly provider: RelayProvider
	readonly projectName: string
	readonly deployUrl: string
}): {
	name: string
	proxyUrl: string
	type: RelayProvider
	noProxy: string
	isActive: boolean
	strictProxy: boolean
} {
	return {
		name: input.projectName,
		proxyUrl: input.deployUrl,
		type: input.provider,
		noProxy: "",
		isActive: true,
		strictProxy: false,
	}
}
