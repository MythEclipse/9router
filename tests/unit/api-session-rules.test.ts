/**
 * Proof that the API authorises against the cookie the dashboard actually sets.
 *
 * The failure this guards against is silent: a wrong key, a wrong cookie name or a
 * missing `userId` all produce the same symptom — every dashboard call is a 401 —
 * and none of them throws where anyone is looking.
 */
import { jwtVerify, SignJWT } from "jose"
import { describe, expect, test } from "vitest"
import {
	AUTH_TOKEN_COOKIE,
	readCookie,
	resolveSession,
	sessionFromClaims,
} from "../../apps/api/src/infrastructure/session-from-cookie.ts"

const SECRET = "test-secret-that-is-long-enough-for-hs256"

async function sign(claims: Record<string, unknown>, secret = SECRET) {
	return new SignJWT({ authenticated: true, ...claims })
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(new TextEncoder().encode(secret))
}

const cookie = (token: string, name = AUTH_TOKEN_COOKIE) => `${name}=${token}`

describe("readCookie", () => {
	test("it finds a cookie among others", () => {
		expect(readCookie("a=1; auth_token=abc; b=2", "auth_token")).toBe("abc")
	})

	test("a JWT's dots and padding survive intact", () => {
		// Trimming or splitting on `.` would corrupt the token before verification.
		const token = "hdr.pay.sig=="
		expect(readCookie(`x=1; auth_token=${token}`, "auth_token")).toBe(token)
	})

	test("a missing header or missing name is null, not a throw", () => {
		expect(readCookie(null, "auth_token")).toBe(null)
		expect(readCookie(undefined, "auth_token")).toBe(null)
		expect(readCookie("other=1", "auth_token")).toBe(null)
	})

	test("an empty value is absence, not an empty token", () => {
		expect(readCookie("auth_token=", "auth_token")).toBe(null)
		expect(readCookie("auth_token=   ", "auth_token")).toBe(null)
	})

	test("a longer name that starts the same does not match", () => {
		// `auth_token_old` must not be read as `auth_token`.
		expect(readCookie("auth_token_old=stale", "auth_token")).toBe(null)
	})
})

describe("sessionFromClaims", () => {
	test("a named user becomes a session", () => {
		const session = sessionFromClaims({ userId: "u1", email: "a@b.c" })
		expect(session).toMatchObject({ userId: "u1", email: "a@b.c" })
	})

	test("a verified token with no userId is not a session", () => {
		// Signature validity says the token came from us, not that it names anyone.
		expect(sessionFromClaims({ authenticated: true })).toBe(null)
		expect(sessionFromClaims({ userId: "   " })).toBe(null)
		expect(sessionFromClaims({ userId: 42 })).toBe(null)
	})

	test("a missing email falls back to the user id, never undefined", () => {
		expect(sessionFromClaims({ userId: "u1" })?.email).toBe("u1")
	})

	test("API-key claims are carried through, because usage is scoped by them", () => {
		const session = sessionFromClaims({
			userId: "key:abc",
			role: "apikey",
			apiKey: "sk-1",
			allowedEndpoints: ["/v1/chat"],
		})
		expect(session).toMatchObject({ role: "apikey", apiKey: "sk-1" })
	})
})

describe("resolveSession", () => {
	test("a token signed with the shared secret resolves", async () => {
		const token = await sign({ userId: "u1", email: "a@b.c" })
		await expect(resolveSession(cookie(token), SECRET, jwtVerify)).resolves.toMatchObject({
			userId: "u1",
		})
	})

	test("a token signed with a different secret is null, not an exception", async () => {
		// Two processes with different DATA_DIR produce exactly this.
		const token = await sign({ userId: "u1" }, "some-other-secret-entirely")
		await expect(resolveSession(cookie(token), SECRET, jwtVerify)).resolves.toBe(null)
	})

	test("a tampered payload fails the signature", async () => {
		const token = await sign({ userId: "u1" })
		const [header, , signature] = token.split(".")
		const forged = `${header}.${Buffer.from(JSON.stringify({ userId: "admin" })).toString("base64url")}.${signature}`
		await expect(resolveSession(cookie(forged), SECRET, jwtVerify)).resolves.toBe(null)
	})

	test("an unsigned alg:none token is refused", async () => {
		// This is the forgery the pinned algorithms list exists to block.
		const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
		const payload = Buffer.from(JSON.stringify({ userId: "admin" })).toString("base64url")
		await expect(resolveSession(cookie(`${header}.${payload}.`), SECRET, jwtVerify)).resolves.toBe(
			null,
		)
	})

	test("an expired token is null", async () => {
		const now = Math.floor(Date.now() / 1000)
		const expired = await new SignJWT({ userId: "u1" })
			.setProtectedHeader({ alg: "HS256" })
			.setIssuedAt(now - 7200)
			.setExpirationTime(now - 3600)
			.sign(new TextEncoder().encode(SECRET))
		await expect(resolveSession(cookie(expired), SECRET, jwtVerify)).resolves.toBe(null)
	})

	test("no cookie, no session", async () => {
		await expect(resolveSession(null, SECRET, jwtVerify)).resolves.toBe(null)
		await expect(resolveSession("other=1", SECRET, jwtVerify)).resolves.toBe(null)
	})

	test("the session is read from auth_token, not from any other cookie", async () => {
		const token = await sign({ userId: "u1" })
		await expect(resolveSession(cookie(token, "saml_state"), SECRET, jwtVerify)).resolves.toBe(null)
	})
})
