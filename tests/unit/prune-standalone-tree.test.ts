import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { pruneStandaloneTree } from "../../apps/web/scripts/prune-standalone-tree.mjs"

/**
 * The packaged tree ships two kinds of file the server never opens: Next's
 * output-file-trace manifests and every `sql.js` build except the wasm pair.
 * Together they were 83 MB of a 196 MB standalone build.
 *
 * These tests pin what may and may not be removed, because the failure mode of
 * an over-eager prune is a server that boots and then 500s on the first query.
 */

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "9router-prune-"))
	const server = join(root, "apps", "web", ".next", "server", "app")
	mkdirSync(join(server, "api", "v1"), { recursive: true })
	writeFileSync(join(server, "api", "v1", "route.js"), "// route")
	writeFileSync(join(server, "api", "v1", "route.js.nft.json"), "{}")
	writeFileSync(join(server, "page.js.nft.json"), "{}")

	const dist = join(root, "node_modules", ".bun", "sql.js@1.15.2", "node_modules", "sql.js", "dist")
	mkdirSync(dist, { recursive: true })
	for (const kept of ["sql-wasm.js", "sql-wasm.wasm"]) {
		writeFileSync(join(dist, kept), "// runtime")
	}
	for (const dropped of [
		"sqljs-all.zip",
		"sql-asm-debug.js",
		"worker.sql-wasm.js",
		"sql-wasm-debug.wasm",
	]) {
		writeFileSync(join(dist, dropped), "x".repeat(1024))
	}
	return { root, server, dist }
}

describe("packaged tree prune", () => {
	it("drops every trace manifest", () => {
		const { root, server } = fixture()

		pruneStandaloneTree({ root })

		expect(existsSync(join(server, "api", "v1", "route.js.nft.json"))).toBe(false)
		expect(existsSync(join(server, "page.js.nft.json"))).toBe(false)
		expect(pruneStandaloneTree({ root }).manifests).toBe(0)
	})

	it("keeps the compiled output the manifests describe", () => {
		const { root, server } = fixture()

		pruneStandaloneTree({ root })

		expect(existsSync(join(server, "api", "v1", "route.js"))).toBe(true)
	})

	it("keeps only the sql.js pair initSqlJs can load", () => {
		const { root, dist } = fixture()

		pruneStandaloneTree({ root })

		expect(existsSync(join(dist, "sql-wasm.js"))).toBe(true)
		expect(existsSync(join(dist, "sql-wasm.wasm"))).toBe(true)
		for (const dropped of ["sqljs-all.zip", "sql-asm-debug.js", "worker.sql-wasm.js"]) {
			expect(existsSync(join(dist, dropped)), `${dropped} should be pruned`).toBe(false)
		}
	})

	it("reports the bytes it freed", () => {
		const { root } = fixture()

		const { freed, manifests } = pruneStandaloneTree({ root })

		expect(manifests).toBe(2)
		expect(freed).toBeGreaterThan(4 * 1024)
	})

	it("is a no-op on a missing root rather than throwing", () => {
		expect(pruneStandaloneTree({ root: join(tmpdir(), "9router-prune-does-not-exist") })).toEqual({
			freed: 0,
			manifests: 0,
		})
	})
})
