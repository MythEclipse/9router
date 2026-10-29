import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(__dirname, "../..")

// The route reads settings from SQLite and redirects based on request cookies, so
// there is nothing static to render. Without this export `next build` prerenders
// it, which turns the build into a database writer racing the other prerender
// workers - "SqliteError: database is locked" surfaced as a failed export and
// killed the build intermittently, including in CI.
describe("SAML start route: never prerendered at build time", () => {
	const route = readFileSync(resolve(root, "apps/web/src/app/api/auth/saml/start/route.ts"), "utf8")

	it("declares force-dynamic", () => {
		expect(route).toMatch(/export const dynamic = "force-dynamic";?/)
	})

	it("keeps the cookie-driven redirect behaviour", () => {
		// The cookie name is now `SAML_HANDSHAKE_COOKIE` from the domain module, so this asserts the
		// behaviour rather than one literal spelling: the state cookie is written, and the redirect
		// goes to the IdP.
		expect(route).toContain("SAML_HANDSHAKE_COOKIE")
		expect(route).toMatch(/cookieStore\.set\(\s*SAML_HANDSHAKE_COOKIE,\s*requestId/)
		expect(route).toContain("NextResponse.redirect(authorizeUrl)")
	})
})
