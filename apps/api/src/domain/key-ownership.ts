/**
 * Ownership of a single API key.
 *
 * A session authenticated by a key may only touch keys it created, and never the
 * one it is authenticated with. Both checks existed inline in the PUT and DELETE
 * handlers, written out twice, in a different order each time — so the two verbs
 * disagreed about which check came first and a caller saw a different error
 * depending on which one they used.
 *
 * The rules return a verdict instead of throwing so the caller can choose its
 * error type, and so the ordering is visible in one place.
 */

/** What the row says about who owns it. */
export interface KeyOwnership {
	/** The key's own secret, compared against the caller's. */
	readonly key: string
	/** The secret of the key that created this one, or empty for the dashboard. */
	readonly createdBy: string
}

export interface OwnershipCaller {
	readonly role: string | null
	/** The caller's own secret, when the caller is a key. */
	readonly apiKey?: string | null
	readonly permissions?: { readonly manageApiKeys?: boolean } | null
}

export type OwnershipVerdict =
	| { readonly allowed: true }
	| {
			readonly allowed: false
			readonly reason: "forbidden" | "not_found"
			readonly message: string
	  }

const ALLOWED: OwnershipVerdict = { allowed: true }

/**
 * Whether the caller may see this key.
 *
 * A key session may read only itself. Reporting another key as missing rather
 * than forbidden is deliberate and was the original behaviour: a 403 would
 * confirm that a key with that id exists, which is a lookup oracle for anyone
 * holding a key.
 */
export function mayReadKey(row: KeyOwnership | null, caller: OwnershipCaller): OwnershipVerdict {
	if (row === null) return notFound()
	if (caller.role !== "apikey") return ALLOWED
	if (row.key === caller.apiKey) return ALLOWED
	return notFound()
}

/**
 * Whether the caller may change or delete this key.
 *
 * The order is the point: permission, then existence, then "not your own", then
 * "not someone else's". Written out twice, the two handlers had the permission
 * check first in one and the row fetch first in the other.
 */
export function mayWriteKey(
	row: KeyOwnership | null,
	caller: OwnershipCaller,
	action: "edit" | "delete",
): OwnershipVerdict {
	if (caller.role === "apikey" && caller.permissions?.manageApiKeys !== true) {
		return {
			allowed: false,
			reason: "forbidden",
			message: "Permission denied: manageApiKeys",
		}
	}
	if (row === null) return notFound()

	if (caller.role === "apikey") {
		// Rotating or removing the credential you are holding would lock you out of
		// the session mid-request, and an operator who does it by accident has no way
		// back in. The dashboard does it for the password session instead.
		if (row.key === caller.apiKey) {
			return {
				allowed: false,
				reason: "forbidden",
				message: "Cannot manage your own API key",
			}
		}
		if (row.createdBy !== caller.apiKey) {
			return {
				allowed: false,
				reason: "forbidden",
				message: `Permission denied: cannot ${action} other keys`,
			}
		}
	}

	return ALLOWED
}

function notFound(): OwnershipVerdict {
	return { allowed: false, reason: "not_found", message: "Key not found" }
}
