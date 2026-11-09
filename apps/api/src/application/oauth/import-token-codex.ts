/**
 * Import-token: Codex token import.
 */
import { codexClaimsOf, codexConnectionName, textFieldOf } from "../../domain/credential-import.ts"
import type { ImportOutcome, ImportTokenDeps } from "./import-token-types.ts"
import { bodyOf, messageOf } from "./import-token-types.ts"

/**
 * `POST /api/oauth/codex/import-token` — a ChatGPT access token, read but not verified.
 *
 * There is no verification call here on purpose: the token was created in ChatGPT's own
 * settings and carries its claims inside itself. The claims are read locally so the row is
 * named and filterable, and the token is stored as `access_token` — it has no refresh token,
 * so recording it as `oauth` would make the refresh path try to renew something it cannot.
 */
export async function importCodexToken(
	rawBody: unknown,
	deps: ImportTokenDeps,
): Promise<ImportOutcome> {
	const body = bodyOf(rawBody)
	const token = textFieldOf(body.accessToken)
	if (!token) return { ok: false, status: 400, error: "Access token is required" }

	const claims = codexClaimsOf(token)
	try {
		const connection = await deps.create({
			provider: "codex",
			authType: "access_token",
			accessToken: token,
			name: codexConnectionName(textFieldOf(body.name), claims),
			email: claims.email,
			providerSpecificData: {
				authMethod: "access_token",
				...(claims.chatgptAccountId ? { chatgptAccountId: claims.chatgptAccountId } : {}),
				...(claims.chatgptPlanType ? { chatgptPlanType: claims.chatgptPlanType } : {}),
				...(claims.expiresAtEpoch ? { jwtExp: claims.expiresAtEpoch } : {}),
			},
			testStatus: "active",
		})
		return { ok: true, connection }
	} catch (error) {
		return { ok: false, status: 502, error: messageOf(error) }
	}
}
