/**
 * Custom-model rules: which capability keys survive, and which STT transports
 * are recognised.
 *
 * The handler whitelisted capability keys by walking `CAPACITY_META` and kept
 * only the boolean ones. That is the right policy — a client can post anything,
 * and a string where a boolean belongs would make the router's `if (caps.vision)`
 * pass for `"false"` — but it lived inside the route, so the same whitelist had
 * to be remembered by anything else writing a custom model.
 */

export type CapabilityPatch = Record<string, boolean>

export type CustomModelRefusal = { code: "VALIDATION"; message: string }

export interface CustomModelInput {
	providerAlias: unknown
	id: unknown
	type?: unknown
	caps?: unknown
	transport?: unknown
}

export interface CustomModelFields {
	providerAlias: string
	id: string
	type: string
	caps: CapabilityPatch | null
	transport: string | null
}

/**
 * Keep only the capability keys in `known` whose value is a real boolean.
 *
 * `null` when nothing survived, which the store reads as "no caps recorded" and
 * the reader then falls back to the name heuristic.
 */
export function sanitizeCaps(caps: unknown, known: readonly string[]): CapabilityPatch | null {
	if (!caps || typeof caps !== "object") return null
	const clean: CapabilityPatch = {}
	for (const key of known) {
		const value = (caps as Record<string, unknown>)[key]
		if (typeof value === "boolean") clean[key] = value
	}
	return Object.keys(clean).length ? clean : null
}

/**
 * A transport only exists for speech-to-text models, and only the markers the
 * shared whitelist knows. Anything else is dropped rather than stored, so a
 * typo cannot leave a model pointing at a transport nothing can dial.
 */
export function sanitizeTransport(
	transport: unknown,
	type: string,
	isKnown: (value: string) => boolean,
): string | null {
	if (type !== "stt" || typeof transport !== "string") return null
	const trimmed = transport.trim()
	return trimmed && isKnown(trimmed) ? trimmed : null
}

/** The required fields, and the normalised body to store when they are present. */
export function readCustomModel(
	input: CustomModelInput,
	knownCaps: readonly string[],
	isKnownTransport: (value: string) => boolean,
): CustomModelFields | CustomModelRefusal {
	if (typeof input.providerAlias !== "string" || !input.providerAlias.trim()) {
		return { code: "VALIDATION", message: "providerAlias and id required" }
	}
	if (typeof input.id !== "string" || !input.id.trim()) {
		return { code: "VALIDATION", message: "providerAlias and id required" }
	}
	const type = typeof input.type === "string" && input.type.trim() ? input.type.trim() : "llm"
	return {
		providerAlias: input.providerAlias.trim(),
		id: input.id.trim(),
		type,
		caps: sanitizeCaps(input.caps, knownCaps),
		transport: sanitizeTransport(input.transport, type, isKnownTransport),
	}
}

export function isCustomModelRefusal(
	value: CustomModelFields | CustomModelRefusal,
): value is CustomModelRefusal {
	return "code" in value
}
