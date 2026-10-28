/**
 * API-key secret material.
 *
 * A key is shown to its owner exactly once. Only a prefix (for lookup) and a
 * hash (for verification) are persisted, so a database leak does not hand out
 * working credentials.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

const PREFIX_LENGTH = 12
const SECRET_BYTES = 32

export interface MintedApiKey {
	/** Full secret, returned to the caller once and never stored. */
	readonly secret: string
	readonly prefix: string
	readonly hash: string
}

export function mintApiKey(): MintedApiKey {
	const secret = `sk-${randomBytes(SECRET_BYTES).toString("base64url")}`
	return {
		secret,
		prefix: secret.slice(0, PREFIX_LENGTH),
		hash: hashApiKey(secret),
	}
}

export function hashApiKey(secret: string): string {
	return createHash("sha256").update(secret).digest("hex")
}

/** Constant-time comparison, so a wrong key leaks nothing through timing. */
export function apiKeyMatches(secret: string, storedHash: string): boolean {
	const presented = Buffer.from(hashApiKey(secret), "hex")
	const stored = Buffer.from(storedHash, "hex")
	if (presented.length !== stored.length) return false
	return timingSafeEqual(presented, stored)
}

export function apiKeyPrefix(secret: string): string {
	return secret.slice(0, PREFIX_LENGTH)
}
