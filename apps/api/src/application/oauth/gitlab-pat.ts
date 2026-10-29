import {
	type GitlabPatInput,
	gitlabDisplayName,
	gitlabUserOf,
	gitlabVerifyFailure,
	isBlockedUrlError,
	readGitlabPatInput,
} from "../../domain/gitlab-pat.ts"

/**
 * Connecting GitLab Duo with a pasted Personal Access Token.
 *
 * Verify, then write. The token is only stored once GitLab itself has confirmed it, because a
 * connection row that exists but never works sends the operator looking in the wrong place —
 * at the model list, or the network — instead of at the token they just pasted.
 */

export interface GitlabPatDeps {
	/**
	 * The fetch to verify with. Injected rather than called directly because *which* fetch
	 * depends on who is asking: a remote caller must go through the SSRF guard, while a local
	 * caller is allowed to reach a self-hosted GitLab on a private network.
	 */
	readonly fetchImpl: typeof globalThis.fetch
	readonly createConnection: (input: Record<string, unknown>) => Promise<unknown>
}

export interface GitlabPatAnswer {
	readonly ok: boolean
	readonly status: number
	readonly body: Record<string, unknown>
}

/**
 * `POST /api/oauth/gitlab/pat` — { token, baseUrl? }.
 *
 * The failure split matters: a refused token is 401 (the operator pastes a different one), a
 * base URL the SSRF guard rejects is 400 (they fix the host), and anything else is 500.
 * Collapsing them would tell the operator to try a new token when the host was the problem.
 */
export async function importGitlabPat(
	body: unknown,
	deps: GitlabPatDeps,
): Promise<GitlabPatAnswer> {
	const parsed = readGitlabPatInput(body)
	if (!parsed.ok || !parsed.input) {
		return { ok: false, status: 400, body: { error: parsed.error } }
	}
	const input = parsed.input

	try {
		const user = await verifiedUser(input, deps)
		if (typeof user === "string") return { ok: false, status: 401, body: { error: user } }

		await deps.createConnection({
			provider: "gitlab",
			authType: "oauth",
			accessToken: input.token,
			refreshToken: null,
			expiresAt: null,
			email: user.email,
			displayName: gitlabDisplayName(user),
			testStatus: "active",
			providerSpecificData: {
				username: user.username,
				email: user.email,
				name: user.name,
				baseUrl: input.baseUrl,
				authKind: "personal_access_token",
			},
		})

		return { ok: true, status: 200, body: { success: true } }
	} catch (error) {
		// The guard's refusal is the operator's host, not a broken server.
		if (isBlockedUrlError(error)) {
			return { ok: false, status: 400, body: { error: "URL not allowed" } }
		}
		const message = error instanceof Error ? error.message : "Unknown error"
		return { ok: false, status: 500, body: { error: message } }
	}
}

/**
 * Asks GitLab who the token belongs to.
 *
 * Answers the user record, or the rejection message as a string — two outcomes rather than a
 * thrown error, because a refused token is an expected answer here, not a fault.
 */
async function verifiedUser(input: GitlabPatInput, deps: GitlabPatDeps) {
	const response = await deps.fetchImpl(`${input.baseUrl}/api/v4/user`, {
		headers: { "Private-Token": input.token, Accept: "application/json" },
	})

	if (!response.ok) return gitlabVerifyFailure(response.status, await response.text())
	return gitlabUserOf(await response.json())
}
