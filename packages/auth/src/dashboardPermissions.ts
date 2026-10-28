import { FULL_PERMISSIONS, normalizePermissions } from "@9router/db/shared/permissionPaths"
import { cookies } from "next/headers"
import { getDashboardAuthSession } from "./dashboardSession.ts"

export {
	canGrantPermissions,
	canOpenPage,
	clampPermissions,
	DEFAULT_PERMISSIONS,
	FULL_PERMISSIONS,
	firstAllowedPage,
	normalizePermissions,
	PERMISSION_KEYS,
	requiredPermissionsForApiPath,
	requiredPermissionsForPage,
} from "@9router/db/shared/permissionPaths"

// Usage rows are always scoped to the key that authenticated the session, so an
// API key login can never read another key's numbers.
export async function getSessionContext() {
	const cookieStore = await cookies()
	const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
	if (!session) return { session: null, permissions: FULL_PERMISSIONS, apiKeyFilter: null }
	const isApiKey = session.role === "apikey"
	return {
		session,
		permissions: isApiKey ? normalizePermissions(session.permissions) : FULL_PERMISSIONS,
		apiKeyFilter: isApiKey ? session.apiKey : null,
		allowedModels: session.allowedModels || "*",
		allowedEndpoints: Array.isArray(session.allowedEndpoints) ? session.allowedEndpoints : [],
	}
}
