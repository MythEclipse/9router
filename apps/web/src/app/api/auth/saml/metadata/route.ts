import { generateSamlMetadata } from "@9router/auth/saml"
import { samlMetadataErrorBody } from "9router-api/domain/sso-probe"
import { getSettings } from "@/lib/localDb"

export const dynamic = "force-dynamic"

/**
 * GET /api/auth/saml/metadata - the SP metadata an IdP imports.
 *
 * Generation can fail on a bad certificate or a missing entry point, and the error body is *also*
 * XML: an unescaped message breaks the document the operator is trying to import, so the failure
 * looks like a broken URL rather than the configuration error it is.
 */
export async function GET(request) {
	try {
		const settings = await getSettings()
		const metadataXml = generateSamlMetadata(new URL(request.url).origin, settings)

		return new Response(metadataXml, {
			status: 200,
			headers: {
				"Content-Type": "application/xml",
				"Cache-Control": "no-cache",
			},
		})
	} catch (error) {
		return new Response(samlMetadataErrorBody(error?.message), {
			status: 500,
			headers: {
				"Content-Type": "application/xml",
			},
		})
	}
}
