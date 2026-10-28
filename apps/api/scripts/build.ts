/**
 * Bundle apps/api for release.
 *
 * esbuild (which `bun build` drives) inlines JavaScript and nothing else. The
 * migration journal is read from disk at runtime, relative to the bundled
 * module's own URL — so it must be copied beside the bundle and its presence
 * asserted here. A payload without it finds an empty directory and reports
 * success while applying no schema, which is the worst possible failure: a
 * running server with an empty database.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// This file lives in scripts/, so the package root is one level up.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, "dist")
const migrations = join(root, "migrations")

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const build = Bun.spawnSync(
	[
		"bun",
		"build",
		join(root, "src/main.ts"),
		"--target=bun",
		"--format=esm",
		"--outdir",
		dist,
		"--external",
		"bun:sqlite",
	],
	{ stdio: ["inherit", "inherit", "inherit"] },
)

if (build.exitCode !== 0) {
	console.error("api build failed")
	process.exit(build.exitCode ?? 1)
}

// Mirror the journal where the bundled migrator resolves it: dist/ is one level
// below the package root, so src/infrastructure/db/migrate.ts resolves
// "../../../migrations" to <package>/migrations at runtime. Keep that invariant.
const target = join(dist, "migrations")
cpSync(migrations, target, { recursive: true })

const shipped = readdirSync(target).filter((f) => f.endsWith(".sql"))
if (shipped.length === 0) {
	console.error(`no .sql migrations reached ${target} — the payload would start on an empty schema`)
	process.exit(1)
}

for (const entry of ["main.js"]) {
	if (!existsSync(join(dist, entry))) {
		console.error(`build produced no ${entry}`)
		process.exit(1)
	}
}

console.log(`api bundled: ${shipped.length} migration(s) shipped with the payload`)
