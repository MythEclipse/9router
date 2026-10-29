import {
	KIRO_IMPORT_REFUSAL_STATUS,
	kiroImportPayload,
	kiroImportRefusalMessage,
	kiroImportSummary,
} from "9router-api/domain/kiro-import"
import { NextResponse } from "next/server"
import { normalizeKiroExternalIdpAuth } from "@/lib/oauth/kiroExternalIdp"
import { createProviderConnection } from "@/models"

export const dynamic = "force-dynamic"

/**
 * POST /api/oauth/kiro/import-cli-proxy
 * Import Kiro CLIProxyAPI auth JSON for Microsoft external_idp accounts.
 *
 * The envelope guess and the refusal message are in `domain/kiro-import`; the normaliser stays
 * here because it is the component that knows which fields a Kiro auth blob must carry.
 */
export async function POST(request) {
	try {
		const body = await request.json()
		const tokenData = normalizeKiroExternalIdpAuth(kiroImportPayload(body))

		const connection = await createProviderConnection({
			provider: "kiro",
			authType: "oauth",
			accessToken: tokenData.accessToken,
			refreshToken: tokenData.refreshToken,
			expiresAt: tokenData.expiresAt,
			email: tokenData.email || null,
			providerSpecificData: tokenData.providerSpecificData,
			testStatus: "active",
		})

		return NextResponse.json(kiroImportSummary(connection))
	} catch (error) {
		return NextResponse.json(
			{ error: kiroImportRefusalMessage(error) },
			{ status: KIRO_IMPORT_REFUSAL_STATUS },
		)
	}
}
