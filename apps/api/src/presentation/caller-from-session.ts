/**
 * The caller, as the key rules need to see them.
 *
 * This replaces `passwordSessionCaller()`, which returned
 * `{ role: "admin", permissions: null }` for every request and justified it with
 * "this transport authenticates with better-auth, so every caller here is a password
 * session". That was true of the transport that existed when it was written. It
 * stopped being true as soon as the dashboard called the router with an API-key
 * session, and the consequences were not cosmetic:
 *
 *   - `mayCreateSubKey("admin", …)` returns `true` unconditionally, so a key session
 *     that lacks `manageApiKeys` could mint keys — the escalation the gate exists to
 *     stop.
 *   - `permissionsForSubKey("admin", …)` returns what was asked for, so a key
 *     session could grant permissions that `domain/sub-key-scope.ts` otherwise clamps
 *     to the default.
 *
 * Deriving the caller from the session instead means the domain rules see what they
 * were written to see. A password session still comes out unrestricted — not because
 * it is labelled `admin`, but because it genuinely carries no `apikey` role, no caps
 * and no permissions, which is the absence those rules already read as "no limit".
 */
import type { ApiKeyCaller } from "../application/api-keys/manage-api-keys-dashboard.ts"
import { asKeyPermissions } from "../domain/sub-key-scope.ts"
import type { SessionClaims } from "./orpc/base.ts"

/** The role a password session carries. Not `apikey`; the rules branch on that. */
export const PASSWORD_SESSION_ROLE = "admin"

/** The literal every key rule compares against to recognise a key session. */
export const API_KEY_SESSION_ROLE = "apikey"

/**
 * Limits and model/endpoint caps the caller passes on to keys they create.
 *
 * Fields pass through as-is: `asLimit` and the scope rules in `domain/` already
 * decide what an absent or malformed value means, and normalising here would be a
 * second opinion they cannot see.
 */
function creatorScopeOf(session: SessionClaims) {
	const endpoints = session.allowedEndpoints
	return {
		tokenLimit: session.tokenLimit as number | null | undefined,
		dailyCostLimit: session.dailyCostLimit as number | null | undefined,
		allowedModels: session.allowedModels as string | null | undefined,
		allowedEndpoints: Array.isArray(endpoints) ? (endpoints as readonly string[]) : null,
	}
}

/** Whether this session was authenticated by an API key. */
export function isKeySession(session: SessionClaims | null | undefined): boolean {
	return session?.role === API_KEY_SESSION_ROLE
}

/**
 * Translate a resolved session into the caller shape the key rules take.
 *
 * `null` in, `null` out: there is no caller to describe, and returning a permissive
 * default here is the bug this function was written to remove. Handlers must handle
 * the absence — `authed` already refuses it with a 401 before any handler runs.
 */
export function callerFromSession(session: SessionClaims | null | undefined): ApiKeyCaller | null {
	if (!session) return null
	const isKey = isKeySession(session)
	return {
		role: isKey ? API_KEY_SESSION_ROLE : PASSWORD_SESSION_ROLE,
		apiKey: isKey ? ((session.apiKey as string | null | undefined) ?? null) : null,
		keyName: (session.keyName as string | null | undefined) ?? null,
		keyId: (session.keyId as string | null | undefined) ?? null,
		scope: creatorScopeOf(session),
		permissions: asKeyPermissions(session.permissions),
	}
}
