/**
 * The packaged tree must be the tree that was built.
 *
 * Two trees are packaged from `apps/web`, and both are checked here because both have shipped stale
 * code before:
 *
 *   `.next/standalone/apps/web`  `copy-standalone-assets.mjs`, run by `bun run build`  (always)
 *   `cli/app`                    `build-cli.ts` `copyStandaloneBuild`, run by `bun run build:cli`
 *
 * Both copy `src/`, `scripts/`, `open-sse/` and `migrations/` **as source**, not as compiled output.
 * That makes the packaging step the one place where a working build can still ship an older commit:
 * the compiler ran on `apps/web/src`, but the server reads whatever landed in the copy, and until
 * now nothing compared the two.
 *
 * It has happened. `cli/moon.yml` records that a fix to `apps/web/scripts/auth-guard-hooks.mjs`
 * "silently never shipped" because the cached payload was reused. And the `cli/app` on disk during
 * this migration was dated a day behind `apps/web` with 211 differing files and 51 missing, 32 of
 * them under `auth/` — including `sse/services/auth.ts` and the OIDC/SAML routes. A unit test cannot
 * see any of it: both trees compile, both pass, and only the bytes on disk disagree.
 *
 * What is checked, in the order it fails:
 *
 *   1. the packaged tree exists at all — otherwise this is a report about nothing
 *   2. every copied file is byte-identical to its source, and none is missing
 *   3. the runtime assets exist: migrations, the bundled MITM server, the guard's aliases
 *
 * A file present in a package but not in the source is only allowed where a staging step is known to
 * add one, so that list is explicit rather than "anything goes".
 *
 * Skipped, not failed, when a tree is absent: a clean checkout has not run the build, and a suite
 * that fails before the build has run teaches people to skip it. `git status` already says whether
 * `cli/app` was ever built.
 */
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const REPO = join(__dirname, "..", "..")
const WEB = join(REPO, "apps", "web")

const COPIED = ["src", "scripts", "open-sse"] as const

/** Files a staging step generates rather than copies. Nothing else may appear. */
const GENERATED = new Set(["src/mitm/server.js"])

function walk(root: string): string[] {
	const found: string[] = []
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry)
			if (statSync(full).isDirectory()) visit(full)
			else found.push(relative(root, full))
		}
	}
	visit(root)
	return found
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function differingFiles(sourceRoot: string, stagedRoot: string): string[] {
	return walk(sourceRoot).filter((file) => {
		const staged = join(stagedRoot, file)
		if (!existsSync(staged)) return false
		return sha256(join(sourceRoot, file)) !== sha256(staged)
	})
}

function missingFiles(sourceRoot: string, stagedRoot: string): string[] {
	return walk(sourceRoot).filter((file) => !existsSync(join(stagedRoot, file)))
}

function unexpectedFiles(sourceRoot: string, stagedRoot: string): string[] {
	return walk(stagedRoot)
		.filter((file) => !existsSync(join(sourceRoot, file)))
		.map((file) => file.split("\\").join("/"))
}

const STANDALONE = join(WEB, ".next", "standalone", "apps", "web")
const CLI_APP = join(REPO, "cli", "app")

describe.skipIf(!existsSync(STANDALONE))(
	"the standalone package matches the tree that was built",
	() => {
		for (const dir of COPIED) {
			describe(dir, () => {
				const sourceRoot = join(WEB, dir)
				const stagedRoot = join(STANDALONE, dir)

				it("has no file that differs from its source", () => {
					// The `auth-guard-hooks.mjs` case: the build succeeded, the bytes that ship are
					// from an older commit, and no other test in this suite can see it.
					expect(
						differingFiles(sourceRoot, stagedRoot),
						`stale files in ${dir}/ — re-run bun run build`,
					).toEqual([])
				})

				it("is missing no file the source has", () => {
					expect(missingFiles(sourceRoot, stagedRoot), `missing from the package: ${dir}/`).toEqual([])
				})

				it("adds nothing beyond the files a staging step generates", () => {
					// `unexpectedFiles` answers paths relative to the copied directory, so the generated
					// file is `mitm/server.js` here while `GENERATED` names it from the app root.
					const allowed = new Set([...GENERATED].map((file) => file.replace(new RegExp(`^${dir}/`), "")))
					const extra = unexpectedFiles(sourceRoot, stagedRoot).filter((file) => !allowed.has(file))
					expect(extra, `unexpected files in the package: ${dir}/`).toEqual([])
				})
			})
		}

		it("carries the migrations the migrator reads at runtime", () => {
			// `next build` never traces this directory — it is read at runtime — so without the
			// copy every route that touches the database answers 500 "Migration journal not found".
			const migrations = join(STANDALONE, "migrations")
			expect(existsSync(migrations), "standalone build has no migrations/").toBe(true)
			expect(walk(migrations).length).toBeGreaterThan(0)
			expect(walk(migrations).some((file) => file.endsWith(".sql"))).toBe(true)
		})

		it("carries a MITM server the spawn can actually execute", () => {
			// `src/` is copied as source, so the server is `server.ts` there. The child is spawned as
			// `process.execPath` + path, and node cannot run a `.ts` file: without the bundled `.js`
			// enabling MITM fails at spawn with an ENOENT that names no cause.
			const server = join(STANDALONE, "src", "mitm", "server.js")
			expect(existsSync(server), "standalone build has no src/mitm/server.js").toBe(true)
			expect(statSync(server).size).toBeGreaterThan(0)
		})

		it("carries the dashboard guard beside the aliases it resolves", () => {
			// The guard lives in `src/` and is loaded by absolute path. It imports `open-sse/*`, which
			// are jsconfig aliases Node's resolver does not understand, so the copy step keeps the
			// `open-sse/` tree beside `src/` for those specifiers to resolve. Check the pair, not a
			// root-level `dashboardGuard.js` — that file has never existed.
			expect(
				existsSync(join(STANDALONE, "src", "dashboardGuard.ts")),
				"no src/dashboardGuard.ts",
			).toBe(true)
			expect(existsSync(join(STANDALONE, "open-sse")), "no open-sse/ for the guard's aliases").toBe(
				true,
			)
		})
	},
)

describe.skipIf(!existsSync(CLI_APP))("the cli package carries what its launcher needs", () => {
	/**
	 * `cli/app` must not be compared file-by-file against `apps/web/src`, and finding out why took four
	 * wrong versions of this test. Each wrong version was a plausible assumption about the package,
	 * and each one is recorded here because the next person will have the same ones.
	 *
	 * **Wrong: "the copies of `src/` must match the source."** `next.config.mjs` sets
	 * `transpilePackages: ["9router-api"]`, so the API package is compiled *into* the build, not read
	 * at runtime. The `src/*.ts` files in `cli/app` are source the running server never executes —
	 * `bun server.js` answers `{"ok":true}` while 181 of them still import `@9router/*`, a specifier
	 * with no package beside the tree. A byte comparison reported 211 stale files; a length
	 * comparison reported 181. Neither number meant anything.
	 *
	 * **Wrong: "the build output is `.next/`."** It is `.next-cli-build/`, set per package.
	 *
	 * **Wrong: "the package must carry `migrations/`."** It does not, and the standalone tree in
	 * `apps/web/.next` does — they are different distributions. The CLI migrates *the user's*
	 * install: its log reads `[db][migrate] up to date at ~/.9router`, so the SQL it applies lives in
	 * the install directory, not in the bundle. Copying `migrations/` in would be wrong here even
	 * though it is mandatory there.
	 *
	 * What is actually required is what the launcher touches: its entry points, the compiled build
	 * beside them, and the bundled MITM server. Those are checked; anything else is a guess about a
	 * distribution this test has no way to know.
	 */
	const required = [
		["server.js", "the entry point the launcher runs"],
		["custom-server.js", "the wrapper it spawns"],
		[".next-cli-build", "the compiled build; without it the tree is sources that cannot serve"],
		["open-sse", "the tree the copied guard resolves its aliases against"],
		["src/mitm/server.js", "bundled by build-cli; absent means enabling MITM fails at spawn"],
	] as const

	for (const [path, why] of required) {
		it(`carries ${path} — ${why}`, () => {
			expect(existsSync(join(CLI_APP, path)), `cli/app is missing ${path}: ${why}`).toBe(true)
		})
	}

	it("carries a compiled server, not only sources", () => {
		const server = join(CLI_APP, ".next-cli-build", "server")
		expect(
			existsSync(server),
			"cli/app has no .next-cli-build/server — re-run bun run build:cli",
		).toBe(true)
		expect(walk(server).length).toBeGreaterThan(0)
	})
})
