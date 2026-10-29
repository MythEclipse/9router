import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { getSettings } from "@9router/db/repos/settingsRepo"
import { DATA_DIR } from "@9router/db/shared/dataDir"
import bcrypt from "bcryptjs"
import { jwtVerify, SignJWT } from "jose"

// Fork default password; upstream's 24h session lifetime is kept.
const DEFAULT_PASSWORD = "123456"
const SESSION_MAX_AGE_SEC = 24 * 60 * 60

/**
 * The identity a dashboard session gets when it has no user record behind it.
 *
 * This install is single-tenant: one owner, one dashboard password, and OIDC/SAML
 * standing in for that same owner. The reader side (`sessionFromClaims`,
 * `sessionClaimsOf`) refuses a token that names nobody — a valid signature proves the
 * token came from us, not that it belongs to anyone — so an identity has to be issued
 * with the cookie rather than invented at each reader.
 */
const DASHBOARD_USER_ID = "dashboard"

/**
 * The claims every dashboard session carries, whatever authenticated it.
 *
 * Stamping the identity here rather than at each of the four sign-in paths (login,
 * OIDC, SAML, API key) is what keeps them from drifting: a path that forgets it issues a
 * cookie every guarded route answers 401 to, and the failure surfaces far from the cause.
 */
function sessionClaims(claims) {
	return { authenticated: true, userId: DASHBOARD_USER_ID, ...claims }
}

export async function createDashboardAuthToken(claims = {}) {
	return new SignJWT(sessionClaims(claims))
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime("24h")
		.sign(SECRET)
}

function loadJwtSecret() {
	if (process.env.JWT_SECRET) return process.env.JWT_SECRET
	const file = path.join(DATA_DIR, "jwt-secret")
	try {
		return fs.readFileSync(file, "utf8").trim()
	} catch {}
	fs.mkdirSync(DATA_DIR, { recursive: true })
	const generated = crypto.randomBytes(32).toString("hex")
	fs.writeFileSync(file, generated, { mode: 0o600 })
	return generated
}

const SECRET = new TextEncoder().encode(loadJwtSecret())

export function shouldUseSecureCookie(request) {
	const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true"
	const forwardedProto = request?.headers?.get?.("x-forwarded-proto")
	const isHttpsRequest = forwardedProto === "https"
	return forceSecureCookie || isHttpsRequest
}

export async function verifyDashboardAuthToken(token) {
	if (!token) return false
	try {
		await jwtVerify(token, SECRET)
		return true
	} catch {
		return false
	}
}

export async function getDashboardAuthSession(token) {
	if (!token) return null
	try {
		const { payload } = await jwtVerify(token, SECRET)
		return payload
	} catch {
		return null
	}
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
	const token = await createDashboardAuthToken(claims)
	cookieStore.set("auth_token", token, {
		httpOnly: true,
		secure: shouldUseSecureCookie(request),
		sameSite: "lax",
		path: "/",
		maxAge: SESSION_MAX_AGE_SEC,
	})
}

export function clearDashboardAuthCookie(cookieStore) {
	cookieStore.delete("auth_token")
}

// Verify the current dashboard password (re-auth for sensitive actions).
export async function verifyDashboardPassword(password) {
	if (typeof password !== "string" || !password) return false
	const settings = await getSettings()
	const storedHash = settings?.password
	if (storedHash) return await bcrypt.compare(password, storedHash)
	const initialPassword = process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD
	return password === initialPassword
}
