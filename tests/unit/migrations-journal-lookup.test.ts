import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { findMigrationsDir } from "../../apps/api/src/infrastructure/db/migrate.ts"

/**
 * The migration journal lookup, and the bug that made `bun run dev` serve nothing.
 *
 * `apps/web/src/lib/useCases.ts` used to pass `process.cwd() + "/migrations"`
 * unconditionally. That resolved to `apps/web/migrations`, which only exists in a
 * standalone build — so in a dev tree the migrator was handed a path that does not
 * exist, stopped, and refused. Every database-backed route answered 500 while
 * `/health` and `/api/theme` looked fine: the theme route swallows its error and
 * answers its default, which is how a broken install reads as a working one.
 *
 * The fix passes `undefined` when nothing staged a journal, so the ascent works.
 * These cases pin the ascent itself.
 */
describe("finding the migration journal", () => {
	function tree() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "9router-migrations-"))
		return {
			root,
			/** Create `<dir>/migrations/0001-initial.sql` and return that journal directory. */
			stage(dir: string) {
				const journal = path.join(dir, "migrations")
				fs.mkdirSync(journal, { recursive: true })
				fs.writeFileSync(path.join(journal, "0001-initial.sql"), "SELECT 1;\n")
				return journal
			},
			/** A directory with no journal anywhere below it. */
			empty(...segments: string[]) {
				const dir = path.join(root, ...segments)
				fs.mkdirSync(dir, { recursive: true })
				return dir
			},
		}
	}

	it("finds a journal staged above the searching module", () => {
		const t = tree()
		try {
			const journal = t.stage(t.root)
			const deep = t.empty("apps", "web", "src", "lib")
			expect(findMigrationsDir(deep)).toBe(journal)
		} finally {
			fs.rmSync(t.root, { recursive: true, force: true })
		}
	})

	it("finds a journal that IS the module's own directory", () => {
		const t = tree()
		try {
			const journal = t.stage(t.root)
			// A standalone build stages the journal beside the bundled migrator.
			expect(findMigrationsDir(journal)).toBe(journal)
		} finally {
			fs.rmSync(t.root, { recursive: true, force: true })
		}
	})

	it("answers null when there is no journal, so the caller can decide", () => {
		const t = tree()
		try {
			const lonely = t.empty("apps", "web")
			expect(findMigrationsDir(lonely)).toBeNull()
		} finally {
			fs.rmSync(t.root, { recursive: true, force: true })
		}
	})

	it("does not accept an empty migrations directory as a journal", () => {
		const t = tree()
		try {
			const dir = t.empty("src")
			// A directory named `migrations` with no .sql in it is not a journal;
			// treating it as one would apply nothing and report success.
			fs.mkdirSync(path.join(dir, "migrations"), { recursive: true })
			fs.writeFileSync(path.join(dir, "migrations", "notes.txt"), "not sql\n")
			expect(findMigrationsDir(dir)).toBeNull()
		} finally {
			fs.rmSync(t.root, { recursive: true, force: true })
		}
	})
})
