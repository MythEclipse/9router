/**
 * Provider-node rules shared by the four node endpoints.
 *
 * The create handler, the update handler and the type-specific update handler
 * each carried their own copy of four decisions, and they had drifted:
 *
 *  - **base-URL sanitising.** Create stripped a trailing `/` for openai-type
 *    nodes but only stripped `/messages` for anthropic ones, so
 *    `https://x/v1/` was stored with the slash while `https://x/v1` was not.
 *  - **quota path.** Create defaulted it to `/credits` and prefixed a leading
 *    slash; the per-id update did the same thing in a second implementation.
 *  - **default base URLs.** Three constant objects, two of them identical.
 *  - **duplicate detection.** Create refuses a repeated prefix or name with 409,
 *    but update did not check at all, so an update could recreate the very
 *    duplicate create was protecting against.
 *
 * The types live here too: a node's type decides which sanitisers apply, so the
 * type list and the type behaviour belong in one file.
 */

export const OPENAI_COMPATIBLE = "openai-compatible"
export const ANTHROPIC_COMPATIBLE = "anthropic-compatible"
export const CUSTOM_EMBEDDING = "custom-embedding"

/** The only types a caller may ask for. An omitted type is refused, not defaulted. */
export const PROVIDER_NODE_TYPES = [OPENAI_COMPATIBLE, ANTHROPIC_COMPATIBLE, CUSTOM_EMBEDDING]

export const OPENAI_API_TYPES = ["chat", "responses"]

/** What each type falls back to when the caller sends no base URL. */
export const DEFAULT_BASE_URLS: Record<string, string> = {
	[OPENAI_COMPATIBLE]: "https://api.openai.com/v1",
	[ANTHROPIC_COMPATIBLE]: "https://api.anthropic.com/v1",
	[CUSTOM_EMBEDDING]: "https://api.openai.com/v1",
}

export const DEFAULT_QUOTA_PATH = "/credits"

/** What can go wrong, in the caller's words. The transport picks the status. */
export type NodeRefusal = { code: "VALIDATION" | "CONFLICT" | "NOT_FOUND"; message: string }

export function isProviderNodeType(value: unknown): value is string {
	return typeof value === "string" && PROVIDER_NODE_TYPES.includes(value)
}

/**
 * Trim a base URL and remove the endpoint suffix a caller may have pasted.
 *
 * A base URL is not the endpoint: the router appends `/messages` or
 * `/embeddings` itself, so keeping the suffix the operator copied from the docs
 * produced `…/messages/messages` at request time. Trailing slashes are removed
 * for every type, which the create handler only did for one of them.
 */
export function sanitizeBaseUrl(type: string, raw: unknown): string {
	const fallback = DEFAULT_BASE_URLS[type] ?? ""
	const trimmed = (typeof raw === "string" && raw.trim() ? raw.trim() : fallback).replace(/\/+$/, "")
	if (type === ANTHROPIC_COMPATIBLE && trimmed.endsWith("/messages")) {
		return trimmed.slice(0, -"/messages".length).replace(/\/+$/, "")
	}
	if (type === CUSTOM_EMBEDDING && trimmed.endsWith("/embeddings")) {
		return trimmed.slice(0, -"/embeddings".length).replace(/\/+$/, "")
	}
	return trimmed
}

/**
 * A quota path is a path on the node's own host. A full URL is kept as given
 * (some nodes serve credits from another host), a bare `credits` gains the
 * leading slash the fetcher needs, and nothing else is rewritten.
 */
export function sanitizeQuotaPath(raw: unknown): string {
	if (typeof raw !== "string" || !raw.trim()) return DEFAULT_QUOTA_PATH
	const trimmed = raw.trim()
	if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("/")) return trimmed
	return `/${trimmed}`
}

/**
 * Refuse a node name or prefix another node already uses.
 *
 * Compared case-insensitively: `OpenAI` and `openai` render as two chips but
 * route to one place, which is the duplicate the operator meant to avoid.
 * `exceptId` lets an update keep its own name.
 */
export function findDuplicate(
	nodes: Array<{ id?: string; name?: string; prefix?: string }>,
	{ name, prefix, exceptId }: { name: string; prefix: string; exceptId?: string },
): NodeRefusal | null {
	const others = nodes.filter((node) => node.id !== exceptId)
	if (others.some((node) => node.prefix?.toLowerCase() === prefix.toLowerCase())) {
		return { code: "CONFLICT", message: "A provider with this prefix already exists" }
	}
	if (others.some((node) => node.name?.toLowerCase() === name.toLowerCase())) {
		return { code: "CONFLICT", message: "A provider with this name already exists" }
	}
	return null
}

/** The name and prefix rules, which create and update state identically. */
export function validateNodeFields(fields: { name: unknown; prefix: unknown }): NodeRefusal | null {
	if (typeof fields.name !== "string" || !fields.name.trim()) {
		return { code: "VALIDATION", message: "Name is required" }
	}
	if (typeof fields.prefix !== "string" || !fields.prefix.trim()) {
		return { code: "VALIDATION", message: "Prefix is required" }
	}
	return null
}

/**
 * `apiType` only means anything for an OpenAI-compatible node, and there it
 * decides whether `/chat/completions` or `/responses` is called, so a missing
 * or unknown value is refused rather than defaulted to whichever is first.
 */
export function validateApiType(type: string, apiType: unknown): NodeRefusal | null {
	if (type !== OPENAI_COMPATIBLE) return null
	if (typeof apiType !== "string" || !OPENAI_API_TYPES.includes(apiType)) {
		return { code: "VALIDATION", message: "Invalid OpenAI compatible API type" }
	}
	return null
}
