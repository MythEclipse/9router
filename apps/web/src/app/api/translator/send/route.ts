import { translatorRefreshUsable, translatorSendStatus } from "9router-api/domain/translator"
import { getExecutor } from "open-sse/index"
import { getProviderConnections, updateProviderConnection } from "@/lib/localDb"

export const dynamic = "force-dynamic"

/** Credential fields an executor may return from a refresh. */
interface RefreshedCredentials {
	accessToken?: string
	refreshToken?: string
	idToken?: string
	lastRefreshAt?: string
	expiresIn?: number
	expiresAt?: string
	copilotToken?: string
	copilotTokenExpiresAt?: string
	providerSpecificData?: Record<string, unknown>
}

/** The subset of a connection row this route reads/writes. */
interface TranslatorConnection {
	id: string
	apiKey?: string
	accessToken?: string
	refreshToken?: string
	idToken?: string
	lastRefreshAt?: string
	projectId?: string
	isActive?: boolean
	providerSpecificData?: Record<string, unknown>
}

async function persistRefreshedCredentials(
	connection: TranslatorConnection,
	newCredentials: RefreshedCredentials,
) {
	const updateData: Record<string, unknown> = {}

	if (newCredentials.accessToken) updateData.accessToken = newCredentials.accessToken
	if (newCredentials.refreshToken) updateData.refreshToken = newCredentials.refreshToken
	if (newCredentials.idToken) updateData.idToken = newCredentials.idToken
	if (newCredentials.lastRefreshAt) updateData.lastRefreshAt = newCredentials.lastRefreshAt
	if (newCredentials.expiresIn) {
		updateData.expiresIn = newCredentials.expiresIn
		updateData.expiresAt = new Date(Date.now() + newCredentials.expiresIn * 1000).toISOString()
	} else if (newCredentials.expiresAt) {
		updateData.expiresAt = newCredentials.expiresAt
	}

	const providerSpecificUpdates = {
		...(newCredentials.providerSpecificData || {}),
		...(newCredentials.copilotToken ? { copilotToken: newCredentials.copilotToken } : {}),
		...(newCredentials.copilotTokenExpiresAt
			? { copilotTokenExpiresAt: newCredentials.copilotTokenExpiresAt }
			: {}),
	}
	if (Object.keys(providerSpecificUpdates).length > 0) {
		updateData.providerSpecificData = {
			...(connection.providerSpecificData || {}),
			...providerSpecificUpdates,
		}
	}

	if (Object.keys(updateData).length > 0) {
		await updateProviderConnection(connection.id, updateData)
	}
}

export async function POST(request) {
	try {
		const { provider, model, body } = (await request.json()) as {
			provider: string
			model: string
			body: Record<string, unknown>
		}

		if (!provider || !model || !body) {
			return Response.json(
				{ success: false, error: "provider, model, and body required" },
				{ status: 400 },
			)
		}

		const connections = await getProviderConnections({ provider })
		const connection = connections.find((c) => c.isActive !== false)
		if (!connection) {
			return Response.json(
				{ success: false, error: `No active connection for provider: ${provider}` },
				{ status: 400 },
			)
		}

		const credentials = {
			apiKey: connection.apiKey,
			accessToken: connection.accessToken,
			refreshToken: connection.refreshToken,
			idToken: connection.idToken,
			lastRefreshAt: connection.lastRefreshAt,
			connectionId: connection.id,
			copilotToken: connection.providerSpecificData?.copilotToken,
			copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
			projectId: connection.projectId,
			providerSpecificData: connection.providerSpecificData,
		}

		const executor = getExecutor(provider)
		const stream = body.stream !== false

		let { response } = await executor.execute({ model, body, stream, credentials })

		// Auto-refresh token on 401/403 and retry (same as chatCore.js)
		if (response.status === 401 || response.status === 403) {
			const newCredentials = await executor.refreshCredentials(credentials, console)
			if (translatorRefreshUsable(newCredentials)) {
				Object.assign(credentials, newCredentials)
				await persistRefreshedCredentials(connection, newCredentials)
				;({ response } = await executor.execute({ model, body, stream, credentials }))
			}
		}

		if (!response.ok) {
			const errorText = await response.text()
			console.error(`[Translator] Provider error ${response.status}:`, errorText.slice(0, 500))
			return Response.json(
				{ success: false, error: `Provider error: ${response.status}`, details: errorText },
				{ status: translatorSendStatus(response.status) },
			)
		}

		return new Response(response.body, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		})
	} catch (error) {
		console.error("[Translator] Send error:", error)
		return Response.json(
			{ success: false, error: error instanceof Error ? error.message : "Unknown error" },
			{ status: 500 },
		)
	}
}
