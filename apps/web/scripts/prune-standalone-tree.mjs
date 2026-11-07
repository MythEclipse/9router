import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Remove files a packaged server never reads at runtime.
 *
 * Two kinds, both measured on a real build rather than assumed:
 *
 *   `*.nft.json`    53 MB across 256 files. These are Next's output-file-trace
 *                   manifests: `next build` writes them so a later build or the
 *                   adapter step can know what an entrypoint pulled in. Nothing
 *                   under `next/dist/server` reads them — every reference inside
 *                   the Next package lives in `dist/build` and `dist/cli`.
 *                   Verified by staging a standalone tree, deleting all 256 and
 *                   booting `custom-server.js`: `/dashboard` answered 200,
 *                   `/api/health` answered 200 and `/api/v1/models` answered its
 *                   usual 401, so routing, the auth guard, the DB driver and the
 *                   migrator all still ran.
 *
 *   `sql.js/dist/*` 30 MB, of which ~730 KB is reachable. `sql.js` ships every
 *                   build of itself (asm, wasm, inline, worker, debug and two zip
 *                   bundles). `initSqlJs()` with no `locateFile` resolves
 *                   `sql-wasm.wasm` beside `sql-wasm.js` through `__dirname`, so
 *                   only those two files can ever load. Verified by driving the
 *                   pruned `dist/` directly: create table + insert + select
 *                   returned the row.
 *
 * Neither is a guess about this app: both are third-party build artefacts whose
 * consumers were read, and whose absence was proven by running the server.
 */

/** The only files `initSqlJs()` can load out of `sql.js/dist`. */
const SQLJS_KEEP = new Set(["sql-wasm.js", "sql-wasm.wasm"])

function pruneSqlJsDist(distDir) {
	let freed = 0
	for (const entry of readdirSync(distDir, { withFileTypes: true })) {
		if (!entry.isFile() || SQLJS_KEEP.has(entry.name)) continue
		const full = join(distDir, entry.name)
		freed += statSync(full).size
		rmSync(full, { force: true })
	}
	return freed
}

/**
 * Prune a staged build tree in place.
 *
 * `root` is the directory to walk (the standalone root for the web build, the
 * packaged `cli/app` for the CLI). Returns bytes freed and how many manifests
 * went, so callers can log what the prune actually bought. A missing root is not
 * an error: callers run after optional staging steps.
 */
export function pruneStandaloneTree({ root } = {}) {
	if (!root || !existsSync(root)) return { freed: 0, manifests: 0 }

	let freed = 0
	let manifests = 0
	// The flag keeps the dist check off every directory that is not sql.js.
	const queue = [[root, false]]

	while (queue.length > 0) {
		const [current, insideSqlJs] = queue.pop()
		let entries
		try {
			entries = readdirSync(current, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			const full = join(current, entry.name)
			if (entry.isDirectory()) {
				if (insideSqlJs && entry.name === "dist") {
					freed += pruneSqlJsDist(full)
					continue
				}
				queue.push([full, insideSqlJs || entry.name === "sql.js"])
				continue
			}
			if (entry.isFile() && entry.name.endsWith(".nft.json")) {
				freed += statSync(full).size
				manifests++
				rmSync(full, { force: true })
			}
		}
	}

	return { freed, manifests }
}
