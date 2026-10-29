import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Two separate questions decide whether a procedure equals its route.
 *
 * 1. Does the handler derive anything from the session? That decides argument
 *    equivalence — getting it wrong widens a report or clears a gate.
 * 2. Is the path public? That decides the auth gate, and **the handler cannot answer
 *    it**: `dashboardGuard` denies every `/api/*` path by default and lets through only
 *    the allow-list, before any route handler runs.
 *
 * Conflating them is how `pricing.get` almost became `base`: its GET handler never
 * reads a session, which looks identical to a public read from inside the file. It is
 * not public, so a `base` procedure would have been callable anonymously through oRPC
 * while the REST path it mirrors was not.
 *
 * These cases read the guard's own allow-list, so the list and the expectations below
 * cannot drift apart silently.
 */
const GUARD_SOURCE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../apps/web/src/dashboardGuard.ts",
)

/** Paths the guard documents as reachable without a session. */
const EXPECTED_PUBLIC = [
	"/api/health",
	"/api/init",
	"/api/locale",
	"/api/auth/login",
	"/api/auth/logout",
	"/api/auth/status",
	"/api/auth/oidc",
	"/api/auth/saml",
	"/api/theme",
	"/api/settings/require-login",
]

/** Areas whose routes have been moved onto the oRPC router. */
const MIGRATED = [
	"/api/combos",
	"/api/usage/stats",
	"/api/usage/chart",
	"/api/usage/sparks",
	"/api/usage/logs",
	"/api/usage/history",
	"/api/keys",
	"/api/keys/bulk",
	"/api/error-logs",
	"/api/theme",
	"/api/pricing",
]

function isPublicApi(pathname: string): boolean {
	// Same rule the guard applies: exact match or a path segment below it.
	return EXPECTED_PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/** The router file that backs an area, or `null` when the area has none. */
function routerFileFor(area: string): string | null {
	// Areas are grouped under a router name; `/api/usage/stats` lives in `usage.ts`.
	const name = area.split("/")[2]
	const file = resolve(REPO_ROOT, "apps/api/src/presentation/orpc/routers", `${name}.ts`)
	try {
		readFileSync(file)
		return file
	} catch {
		return null
	}
}

/**
 * Procedure names declared with the public builder.
 *
 * Textual on purpose: importing every router would drag the whole application graph
 * into a unit test, and the shape being checked is a one-line declaration
 * (`name: base.handler(...)`). A false negative here would need the declaration
 * rewritten across lines, which the formatter does not do for these.
 */
function publicProcedureNames(source: string): string[] {
	return [...source.matchAll(/^\s*([A-Za-z_]\w*):\s*base\.handler/gm)].map((m) => m[1])
}

describe("reachability is decided by the guard, not by the handler", () => {
	it("treats only the allow-listed paths as public", () => {
		expect(isPublicApi("/api/theme")).toBe(true)
		expect(isPublicApi("/api/auth/login")).toBe(true)
		// The one that nearly shipped a loosening.
		expect(isPublicApi("/api/pricing")).toBe(false)
		expect(isPublicApi("/api/keys")).toBe(false)
	})

	it("does not treat a prefix as public by accident", () => {
		// `/api/theme` is public; `/api/themes` must not inherit that.
		expect(isPublicApi("/api/themes")).toBe(false)
		expect(isPublicApi("/api/themexyz")).toBe(false)
	})

	it("applies the segment rule to nested paths", () => {
		expect(isPublicApi("/api/auth/login/callback")).toBe(true)
		expect(isPublicApi("/api/keys/bulk")).toBe(false)
	})
})

describe("the migrated routes and their gates", () => {
	it("has exactly one public area among them, and it is theme", () => {
		expect(MIGRATED.filter(isPublicApi)).toEqual(["/api/theme"])
	})

	it("keeps the guard's allow-list in step with what this test assumes", () => {
		const source = readFileSync(GUARD_SOURCE, "utf8")
		const start = source.indexOf("const PUBLIC_API_PATHS")
		expect(start).toBeGreaterThan(-1)
		const allowListBlock = source.slice(start, source.indexOf("]", start))

		// Every path the guard allows must be one this test knows about: a new public
		// path is a new decision about who may reach it, and should fail here first.
		for (const expected of EXPECTED_PUBLIC) {
			expect(allowListBlock).toContain(`"${expected}"`)
		}
		// And the areas this test calls guarded must not appear in that block.
		for (const guarded of ["/api/pricing", "/api/keys", "/api/usage", "/api/combos"]) {
			expect(allowListBlock).not.toContain(`"${guarded}"`)
		}
	})

	it("does not open a procedure on a guarded path to anonymous callers", async () => {
		// The check with teeth: read each router and assert the public builder is only
		// used by an area the guard also lets through. Without this, the rule above is
		// only a comment about the guard — it would not have caught `pricing.get`
		// being switched to `base`, which is exactly what it is here to prevent.
		const publicProcedures: string[] = []
		for (const area of MIGRATED) {
			const routerPath = routerFileFor(area)
			if (!routerPath) continue
			for (const name of publicProcedureNames(readFileSync(routerPath, "utf8"))) {
				publicProcedures.push(`${area}:${name}`)
			}
		}

		const unexpected = publicProcedures.filter((entry) => {
			const [area] = entry.split(":")
			return !isPublicApi(area)
		})
		expect(unexpected).toEqual([])
	})
})
