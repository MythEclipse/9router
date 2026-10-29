/**
 * GitLab Duo connects with a Personal Access Token rather than an OAuth dance.
 *
 * The token is the credential and the base URL is part of it: a self-hosted instance answers
 * `/api/v4/user` on its own host, so what makes a token valid depends on where it is sent.
 */

export const GITLAB_DEFAULT_BASE = "https://gitlab.com"

/**
 * The result of reading the body. Flat rather than a union for the same reason as
 * `DispatchAnswer`: `apps/web` compiles with `strict: false`, where a union cannot be narrowed.
 */
export interface GitlabPatRead {
	readonly ok: boolean
	readonly error?: string
	readonly input?: GitlabPatInput
}

/** What the operator typed, normalised. */
export interface GitlabPatInput {
	readonly token: string
	readonly baseUrl: string
}

/**
 * Reads the body, trimming the token and defaulting the base URL.
 *
 * A trailing slash is dropped rather than tolerated so the paths the caller builds by string
 * concatenation never double up. An empty token is refused here: the route cannot verify a
 * credential nobody supplied, and GitLab would answer 401 with a message about scopes that
 * has nothing to do with the real mistake.
 */
export function readGitlabPatInput(body: unknown): GitlabPatRead {
	const fields = (body ?? {}) as { token?: unknown; baseUrl?: unknown }
	const token = typeof fields.token === "string" ? fields.token.trim() : ""
	if (!token) return { ok: false, error: "Personal Access Token is required" }

	const typedBase = typeof fields.baseUrl === "string" ? fields.baseUrl.trim() : ""
	return {
		ok: true,
		input: { token, baseUrl: (typedBase || GITLAB_DEFAULT_BASE).replace(/\/$/, "") },
	}
}

/** The GitLab user record, as much of it as a connection row needs. */
export interface GitlabUser {
	readonly email: string
	readonly name: string
	readonly username: string
}

/**
 * Reads the user record GitLab answered with.
 *
 * A personal account may hide its primary address, so `public_email` is the fallback; a
 * connection with no email at all is still usable, which is why this never refuses.
 */
export function gitlabUserOf(raw: unknown): GitlabUser {
	const user = (raw ?? {}) as Record<string, unknown>
	const text = (value: unknown) => (typeof value === "string" ? value : "")
	const email = text(user.email) || text(user.public_email)
	return {
		email,
		name: text(user.name),
		username: text(user.username),
	}
}

/**
 * The display name to show on the connections list, falling back through the fields GitLab
 * may or may not have filled in, and finally to the email.
 */
export function gitlabDisplayName(user: GitlabUser): string {
	return user.name || user.username || user.email
}

/** GitLab's own error text, kept verbatim so the operator can see the missing scope. */
export function gitlabVerifyFailure(status: number, body: string): string {
	const detail = body.trim() || `HTTP ${status}`
	return `GitLab token verification failed: ${detail}`
}

/**
 * The SSRF guard refuses by throwing a message beginning "Blocked URL". That is the
 * operator's typo in the base URL, not a server fault, so it must not read as a 500.
 */
export function isBlockedUrlError(error: unknown): boolean {
	const message = (error as { message?: unknown } | null)?.message
	return typeof message === "string" && message.startsWith("Blocked URL")
}
