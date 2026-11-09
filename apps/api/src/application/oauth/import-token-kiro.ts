/**
 * Import-token: Kiro token import.
 */
import {
	identityFieldOf,
	isIdcToken,
	kiroAuthMethodOf,
	kiroProviderLabelOf,
	kiroRegionOf,
	missingImportField,
	textFieldOf,
	tokenExpiryOf,
	validationStatusOf,
} from "../../domain/credential-import.ts"
import type { ImportOutcome, ImportTokenDeps, VerifiedToken } from "./import-token-types.ts"
import { bodyOf, messageOf } from "./import-token-types.ts"

/**
 * `POST /api/oauth/kiro/import` — a refresh token, exchanged for an access token.
 *
 * The token is refreshed rather than used directly: a refresh token from the IDE is the only
 * thing the operator can copy, and the access token it yields is what every later request
 * needs. Whether it is an IDC token decides the endpoint and the fields that must be kept.
 */
export async function importKiroToken(
	rawBody: unknown,
	deps: ImportTokenDeps,
): Promise<ImportOutcome> {
	const body = bodyOf(rawBody)
	const refreshToken = textFieldOf(body.refreshToken)
	if (!refreshToken) return { ok: false, status: 400, error: "Refresh token is required" }

	const clientId = textFieldOf(body.clientId)
	const clientSecret = textFieldOf(body.clientSecret)
	const region = kiroRegionOf(textFieldOf(body.region))
	const idc = isIdcToken(clientId, clientSecret)

	const providerSpecificData: Record<string, unknown> = idc
		? { clientId, clientSecret, region, authMethod: kiroAuthMethodOf(true) }
		: {}

	let verified: VerifiedToken
	try {
		verified = await deps.verify({ accessToken: refreshToken, providerSpecificData })
	} catch (error) {
		return { ok: false, status: validationStatusOf(error), error: messageOf(error) }
	}

	try {
		const connection = await deps.create({
			provider: "kiro",
			authType: "oauth",
			accessToken: verified.accessToken,
			refreshToken: verified.refreshToken || refreshToken,
			expiresAt: tokenExpiryOf(verified.expiresIn, deps.now()),
			email: verified.email ?? null,
			providerSpecificData: {
				profileArn: textFieldOf(body.profileArn) || verified.providerSpecificData?.profileArn || null,
				authMethod: kiroAuthMethodOf(idc),
				provider: kiroProviderLabelOf(idc),
				...(idc ? { clientId, clientSecret, region } : {}),
			},
			testStatus: "active",
		})
		return { ok: true, connection }
	} catch (error) {
		return { ok: false, status: 502, error: messageOf(error) }
	}
}
