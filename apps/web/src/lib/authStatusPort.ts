/**
 * The host side of the auth-status use-case.
 *
 * Two reads, both owned here because both touch process state the `apps/api` graph must not import:
 * the settings row and the auth cookie. The permission catalog is passed through rather than read
 * by the domain for the same reason — `permissionPaths` lives in the database package.
 *
 * Nothing in this file decides anything. It fetches and hands over.
 */
import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { isOidcConfigured } from "@9router/auth/oidc"
import { isSamlConfigured } from "@9router/auth/saml"
import {
	DEFAULT_PERMISSIONS,
	FULL_PERMISSIONS,
	firstAllowedPage,
	normalizePermissions,
} from "@9router/db/shared/permissionPaths"
import type { AuthStatusRequest } from "9router-api/application/use-cases"
import type { SessionClaims } from "9router-api/domain/auth-status"
import { sessionHomePath } from "9router-api/domain/dashboard-login"
import { cookies } from "next/headers"
import { getSettings } from "@/lib/localDb"

/**
 * Reads the two pieces of host state the use-case needs.
 *
 * The cookie is read per call, not captured at module load: `cookies()` is only valid inside a
 * request scope, and a module-level read would bind to whichever request loaded the module first.
 */
export function authStatusRequest(): AuthStatusRequest {
	return {
		port: {
			settings: () => getSettings(),
			session: async () => {
				const cookieStore = await cookies()
				// `getDashboardAuthSession` returns the verified JWT payload: an open record whose
				// fields are all untrusted, which is exactly what `SessionClaims` describes.
				return (await getDashboardAuthSession(
					cookieStore.get("auth_token")?.value,
				)) as SessionClaims | null
			},
		},
		probes: {
			// The probes read loosely-typed settings records; the domain's view is narrower, so the
			// widening happens here, once, at the boundary — not inside the rule.
			oidcConfigured: (settings) => isOidcConfigured(settings as Record<string, unknown>),
			samlConfigured: (settings) => isSamlConfigured(settings as Record<string, unknown>),
		},
		catalog: {
			full: FULL_PERMISSIONS,
			byDefault: DEFAULT_PERMISSIONS,
			normalize: normalizePermissions,
		},
		homePathFor: sessionHomePath,
		firstAllowedPage,
		// The use-case answers signed-out on failure; the reason still belongs in the log, because
		// "everyone is suddenly logged out" and "the database is down" look identical from outside.
		onFailure: (error) => console.warn("[auth/status] falling back to signed out:", error),
	}
}
