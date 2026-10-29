/**
 * The cookie the dashboard issues must be a cookie the API accepts.
 *
 * Two independent modules decide that, and they disagree silently: `createDashboardAuthToken`
 * signs the claims, `sessionFromClaims` decides which claims name a session. Both had tests;
 * neither tested the seam. The issuer wrote `{ authenticated, role }` and the reader required
 * a `userId`, so every guarded route answered 401 to a correctly-logged-in operator while
 * both suites stayed green. This file only tests the seam.
 *
 * It signs with the same module the login route uses and reads with the same module the API
 * uses, so a change to either side alone fails here.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { jwtVerify } from "jose"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

let temp = ""
let createDashboardAuthToken: (claims?: Record<string, unknown>) => Promise<string>
let sessionFromClaims: (payload: Record<string, unknown>) => { userId?: string } | null
let sessionClaimsOf: (ctx: unknown) => { userId?: string } | null
let secret = ""

beforeAll(async () => {
	// `dashboardSession` reads the JWT secret at import time, so DATA_DIR has to point at a
	// real directory before the module loads. A made-up path would make `loadJwtSecret`
	// generate a secret somewhere else and the verify below would fail for the wrong reason.
	temp = fs.mkdtempSync(path.join(os.tmpdir(), "9router-session-seam-"))
	process.env.DATA_DIR = temp
	vi.resetModules()

	;({ createDashboardAuthToken } = await import("../../packages/auth/src/dashboardSession.ts"))
	;({ sessionFromClaims } = await import("../../apps/api/src/infrastructure/session-from-cookie.ts"))
	;({ sessionClaimsOf } = await import("../../apps/web/src/lib/orpcClient.ts"))
	secret = fs.readFileSync(path.join(temp, "jwt-secret"), "utf8").trim()
})

afterAll(() => {
	fs.rmSync(temp, { recursive: true, force: true })
	delete process.env.DATA_DIR
})

async function payloadOf(token: string) {
	const { payload } = await jwtVerify(token, new TextEncoder().encode(secret))
	return payload as Record<string, unknown>
}

describe("the dashboard cookie is a session the API accepts", () => {
	it("a password login issues claims the API reads as a session", async () => {
		const token = await createDashboardAuthToken({ role: "admin" })
		const payload = await payloadOf(token)

		expect(sessionFromClaims(payload)).toMatchObject({ userId: expect.any(String) })
		expect(sessionClaimsOf({ session: sessionFromClaims(payload), permissions: null })).toMatchObject(
			{ userId: expect.any(String) },
		)
	})

	it("every sign-in path names someone, not just the password one", async () => {
		// The four shapes the four routes actually pass. A path that stops naming someone is
		// the failure this guards: it logs the operator in and then 401s every dashboard call.
		const paths: Record<string, Record<string, unknown>> = {
			password: { role: "admin" },
			apikey: { role: "apikey", keyId: "k1", keyName: "cli", apiKey: "sk-live", permissions: {} },
			oidc: { oidc: true, oidcSub: "sub-1", oidcEmail: "a@b.c" },
			saml: { saml: true, samlEmail: "a@b.c", samlName: "A" },
		}
		for (const [name, claims] of Object.entries(paths)) {
			const payload = await payloadOf(await createDashboardAuthToken(claims))
			expect(sessionFromClaims(payload), `${name} names nobody`).not.toBeNull()
		}
	})

	it("still refuses a signed token that names nobody", async () => {
		// The reader's rule is what makes the identity necessary, so it has to survive this
		// fix. A token from `SignJWT` directly stands in for a cookie issued by an older build.
		const { SignJWT } = await import("jose")
		const unsigned = await new SignJWT({ authenticated: true, role: "admin" })
			.setProtectedHeader({ alg: "HS256" })
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(new TextEncoder().encode(secret))

		expect(sessionFromClaims(await payloadOf(unsigned))).toBeNull()
	})

	it("lets a caller-supplied id win over the default, so a real user is not overwritten", async () => {
		const payload = await payloadOf(await createDashboardAuthToken({ userId: "u-real" }))
		expect(sessionFromClaims(payload)).toMatchObject({ userId: "u-real" })
	})
})
