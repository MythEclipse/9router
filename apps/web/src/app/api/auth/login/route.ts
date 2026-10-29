import { setDashboardAuthCookie } from "@9router/auth/dashboardSession"
import { checkLock, getClientIp, recordFail, recordSuccess } from "@9router/auth/loginLimiter"
import { isOidcConfigured } from "@9router/auth/oidc"
import { isSamlConfigured } from "@9router/auth/saml"
import { isTrustedNetworkRequest } from "@9router/auth/trustedPeer"
import { recordSecurityEvent } from "@9router/db/repos/securityLogRepo"
import { firstAllowedPage, normalizePermissions } from "@9router/db/shared/permissionPaths"
import {
	apiKeyAdmitsSession,
	apiKeyRejectionReason,
	credentialRejection,
	DEFAULT_PASSWORD_REFUSAL,
	isTunnelRequest,
	keyFingerprint,
	lockoutMessage,
	mustChangeDefaultPassword,
	PASSWORD_RESET_HINT,
	permissionsPreview,
	ssoPasswordRefusal,
	ssoPasswordRefusalMessage,
	tunnelDashboardAllowed,
} from "9router-api/domain/dashboard-login"
import bcrypt from "bcryptjs"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { getSettings } from "@/lib/localDb"

export const dynamic = "force-dynamic"

// One helper so every branch below writes the same shape, and so the raw secret
// can never reach the log by accident.
function audit(request, ip, event) {
	return recordSecurityEvent({
		...event,
		ip,
		method: "POST",
		path: "/api/auth/login",
		userAgent: request.headers?.get?.("user-agent") || "",
	})
}

const NO_STORE_HEADERS = { "Cache-Control": "no-store" }

/** The body for a locked-out caller: the message, the wait, and where to go next. */
function lockedOut(retryAfter: number) {
	return NextResponse.json(
		{
			error: `${lockoutMessage(retryAfter)} ${PASSWORD_RESET_HINT}`,
			retryAfter,
			resetHint: PASSWORD_RESET_HINT,
		},
		{ status: 429, headers: { "Retry-After": String(retryAfter) } },
	)
}

/**
 * Sign in with an API key.
 *
 * A wrong key burns the same attempt counter as a wrong password, so guessing costs the same
 * either way and both answers show what is left.
 */
async function signInWithApiKey(request, ip, settings, rawKey: string) {
	const { validateApiKey, getApiKeyByKey } = await import("@/lib/localDb")
	const keyStr = rawKey.trim()
	const valid = await validateApiKey(keyStr)
	const actor = keyFingerprint(keyStr)

	if (!apiKeyAdmitsSession(valid)) {
		const reason = apiKeyRejectionReason(valid)
		const { remainingBeforeLock } = recordFail(ip)
		const postLock = checkLock(ip)
		if (postLock.locked) {
			await audit(request, ip, {
				type: "apikey_login_locked",
				severity: "warn",
				detail: `Locked out after repeated failures; retry allowed in ${postLock.retryAfter}s`,
				actor,
			})
			return lockedOut(postLock.retryAfter)
		}
		await audit(request, ip, {
			type: "apikey_login_failed",
			severity: "warn",
			// The reason, never the key: this table is readable in the dashboard.
			detail: credentialRejection(reason, remainingBeforeLock),
			actor,
		})
		return NextResponse.json(
			{ error: credentialRejection(reason, remainingBeforeLock), remainingBeforeLock },
			{ status: 401 },
		)
	}

	if (valid === "QUOTA_EXCEEDED") {
		await audit(request, ip, {
			type: "apikey_login_quota",
			severity: "info",
			actor,
			detail: "Signed in despite an exhausted token quota",
		})
	}

	const keyObj = await getApiKeyByKey(keyStr)
	if (!keyObj) {
		return NextResponse.json({ error: "API key not found" }, { status: 401 })
	}

	recordSuccess(ip)
	await audit(request, ip, {
		type: "apikey_login_success",
		severity: "info",
		actor: keyObj.name || keyObj.id,
		detail: `Signed in with API key "${keyObj.name || keyObj.id}" (${permissionsPreview(keyObj.permissions)})`,
	})

	const cookieStore = await cookies()
	const permissions = normalizePermissions(keyObj.permissions)
	await setDashboardAuthCookie(cookieStore, request, {
		role: "apikey",
		keyId: keyObj.id,
		keyName: keyObj.name || "API Key",
		apiKey: keyStr,
		permissions,
		allowedModels: keyObj.allowedModels || "*",
		allowedEndpoints: keyObj.allowedEndpoints || [],
		tokenLimit: keyObj.tokenLimit || 0,
	})

	return NextResponse.json(
		{
			success: true,
			role: "apikey",
			mustChangePassword: false,
			homePath: firstAllowedPage(permissions),
		},
		{ headers: NO_STORE_HEADERS },
	)
}

/** Sign in with the dashboard password, stored as a bcrypt hash or the env/default literal. */
async function signInWithPassword(request, ip, settings, password: string) {
	const storedHash = settings.password

	const refusal = ssoPasswordRefusal({
		...settings,
		samlConfigured: isSamlConfigured(settings),
		oidcConfigured: isOidcConfigured(settings),
	})
	if (refusal !== null) {
		return NextResponse.json({ error: ssoPasswordRefusalMessage(refusal) }, { status: 403 })
	}

	// Default password is '123456' if not set
	const isValid = storedHash
		? await bcrypt.compare(password, storedHash)
		: password === (process.env.INITIAL_PASSWORD || "123456")

	if (!isValid) {
		const { remainingBeforeLock } = recordFail(ip)
		const postLock = checkLock(ip)
		if (postLock.locked) return lockedOut(postLock.retryAfter)
		await audit(request, ip, {
			type: "login_failed",
			severity: "warn",
			detail: `Wrong password; ${remainingBeforeLock} attempt(s) left before lockout`,
		})
		return NextResponse.json(
			{ error: credentialRejection("Invalid password", remainingBeforeLock), remainingBeforeLock },
			{ status: 401 },
		)
	}

	recordSuccess(ip)
	const mustChangePassword = mustChangeDefaultPassword({
		hasStoredPassword: Boolean(storedHash),
		hasInitialPasswordOverride: Boolean(process.env.INITIAL_PASSWORD),
		trustedNetwork: isTrustedNetworkRequest(request),
		allowRemoteDefaultLogin: process.env.ALLOW_REMOTE_DEFAULT_LOGIN === "true",
	})

	if (mustChangePassword) {
		// No session token: a fresh install's default password is public knowledge ("123456"), so
		// handing out a valid JWT would let any remote attacker authenticate and then PATCH
		// /api/settings to disable authentication entirely (CVE-2026-56679 class).
		//
		// This intentionally leaves no remote self-service password-change path: the
		// change-password flow (PATCH /api/settings) requires a JWT, which is deliberately
		// withheld. A remote fresh-install user must change the password from the local machine or
		// set INITIAL_PASSWORD before first launch. That is the trade-off, not an oversight.
		await audit(request, ip, {
			type: "login_default_password",
			severity: "critical",
			detail: "The published default password was used from a remote address; no session was issued",
		})
		return NextResponse.json(
			{ success: false, error: DEFAULT_PASSWORD_REFUSAL, mustChangePassword: true },
			{ status: 403, headers: NO_STORE_HEADERS },
		)
	}

	const cookieStore = await cookies()
	await setDashboardAuthCookie(cookieStore, request, { role: "admin" })
	await audit(request, ip, {
		type: "login_success",
		severity: "info",
		actor: "Password user",
		detail: storedHash ? "Password sign-in" : "Password sign-in using the initial/default password",
	})

	return NextResponse.json(
		{ success: true, role: "admin", mustChangePassword: false },
		{ headers: NO_STORE_HEADERS },
	)
}

export async function POST(request) {
	try {
		const ip = getClientIp(request)
		const lock = checkLock(ip)
		if (lock.locked) {
			await audit(request, ip, {
				type: "login_locked",
				severity: "warn",
				detail: `Locked out after repeated failures; retry allowed in ${lock.retryAfter}s`,
			})
			return lockedOut(lock.retryAfter)
		}

		const { password, apiKey } = await request.json()
		const settings = await getSettings()

		// Block login via tunnel/tailscale if dashboard access is disabled
		if (isTunnelRequest(request.headers.get("host"), settings) && !tunnelDashboardAllowed(settings)) {
			return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 })
		}

		if (apiKey && typeof apiKey === "string" && apiKey.trim()) {
			return await signInWithApiKey(request, ip, settings, apiKey)
		}

		return await signInWithPassword(request, ip, settings, password)
	} catch (error) {
		return NextResponse.json({ error: error.message }, { status: 500 })
	}
}
