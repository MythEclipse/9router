import { beforeEach, describe, expect, it, vi } from "vitest"

// The node:sqlite adapter has no native transaction wrapper, so it builds one
// out of SAVEPOINT with a depth counter. The prepared statements are a hot-path
// optimisation; these tests pin the SEMANTICS so the optimisation cannot quietly
// break atomicity, nesting, or error recovery.
describe("node:sqlite transaction (savepoint by depth)", () => {
	let adapter

	beforeEach(async () => {
		vi.resetModules()
		delete global._dbAdapter
		const driver = await import("@/lib/db/driver.js")
		adapter = await driver.getAdapter()
		adapter.exec("CREATE TABLE IF NOT EXISTS tx_probe(id INTEGER PRIMARY KEY, v TEXT)")
		adapter.exec("DELETE FROM tx_probe")
	})

	it("commits a successful transaction", () => {
		adapter.transaction(() => {
			adapter.run("INSERT INTO tx_probe(v) VALUES(?)", ["a"])
			adapter.run("INSERT INTO tx_probe(v) VALUES(?)", ["b"])
		})
		expect(adapter.get("SELECT COUNT(*) AS n FROM tx_probe")?.n).toBe(2)
	})

	it("rolls back every write in a failed transaction", () => {
		expect(() =>
			adapter.transaction(() => {
				adapter.run("INSERT INTO tx_probe(v) VALUES(?)", ["a"])
				throw new Error("boom")
			}),
		).toThrow("boom")

		expect(adapter.get("SELECT COUNT(*) AS n FROM tx_probe")?.n).toBe(0)
	})

	it("keeps outer writes when an inner transaction rolls back (nesting)", () => {
		adapter.transaction(() => {
			adapter.run("INSERT INTO tx_probe(v) VALUES(?)", ["outer"])
			try {
				adapter.transaction(() => {
					adapter.run("INSERT INTO tx_probe(v) VALUES(?)", ["inner"])
					throw new Error("inner-boom")
				})
			} catch {
				/* the caller decides what to do with the inner failure */
			}
			adapter.run("INSERT INTO tx_probe(v) VALUES(?)", ["after-inner"])
		})

		const vals = adapter.all("SELECT v FROM tx_probe ORDER BY id").map((r) => r.v)
		expect(vals).toEqual(["outer", "after-inner"])
	})

	it("recovers after a rollback so the next transaction still works", () => {
		// The depth counter must return to 0 on the error path, or every later
		// transaction would use a stale savepoint name and fail.
		expect(() =>
			adapter.transaction(() => {
				throw new Error("x")
			}),
		).toThrow()

		adapter.transaction(() => adapter.run("INSERT INTO tx_probe(v) VALUES(?)", ["after"]))
		expect(adapter.get("SELECT COUNT(*) AS n FROM tx_probe")?.n).toBe(1)
	})

	it("survives nesting deeper than the prepared-statement table", () => {
		// 16 pre-prepared levels; go past them to exercise the exec fallback.
		const depth = 20
		adapter.transaction(() => {
			adapter.run("INSERT INTO tx_probe(v) VALUES(?)", ["d0"])
			const nest = (n) => {
				if (n === 0) return
				adapter.transaction(() => {
					adapter.run("INSERT INTO tx_probe(v) VALUES(?)", [`d${n}`])
					nest(n - 1)
				})
			}
			nest(depth)
		})

		expect(adapter.get("SELECT COUNT(*) AS n FROM tx_probe")?.n).toBe(depth + 1)
	})
})
