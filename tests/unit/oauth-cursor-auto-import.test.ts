import { describe, expect, it, vi } from "vitest"
import { autoImportCursor } from "../../apps/api/src/application/oauth/auto-import.ts"
import {
	cursorMissMessage,
	cursorTokensComplete,
} from "../../apps/api/src/domain/oauth-local-credential.ts"

/** The ladder with every port stubbed; each test overrides only what it is about. */
function deps(overrides: Partial<Parameters<typeof autoImportCursor>[0]> = {}) {
	return {
		candidates: ["/home/u/.config/Cursor/User/globalStorage/state.vscdb"],
		readable: async () => true,
		readViaBinding: async () => ({ accessToken: "test-token", machineId: "test-machine-id" }),
		readViaCli: async () => ({ accessToken: null, machineId: null }),
		...overrides,
	}
}

describe("autoImportCursor", () => {
	it("answers both halves when the binding can read the database", async () => {
		const result = await autoImportCursor(deps())
		expect(result).toEqual({
			found: true,
			accessToken: "test-token",
			machineId: "test-machine-id",
		})
	})

	it("lists every path it tried when no database is readable", async () => {
		const tried = [
			"/Users/u/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
			"/Users/u/Library/Application Support/Cursor - Insiders/User/globalStorage/state.vscdb",
		]
		const result = await autoImportCursor(deps({ candidates: tried, readable: async () => false }))
		expect(result.found).toBe(false)
		expect(result).toMatchObject({
			found: false,
			error: expect.stringContaining("Cursor database not found"),
		})
		expect((result as { error: string }).error).toContain(
			"/Users/u/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
		)
		expect((result as { error: string }).error).toContain("state.vscdb")
		expect((result as { error: string }).error).toContain("globalStorage")
	})

	it("uses the first readable path rather than the first listed one", async () => {
		const seen: string[] = []
		await autoImportCursor(
			deps({
				candidates: ["/a", "/b"],
				readable: async (path) => {
					seen.push(path)
					return path === "/b"
				},
				readViaBinding: async (path) => ({ accessToken: "t", machineId: path }),
			}),
		)
		expect(seen).toEqual(["/a", "/b"])
	})

	it("falls back to the sqlite3 CLI when the binding cannot load", async () => {
		const result = await autoImportCursor(
			deps({
				readViaBinding: async () => {
					throw new Error("SQLITE_CANTOPEN")
				},
				readViaCli: async () => ({ accessToken: "cli-token", machineId: "cli-machine" }),
			}),
		)
		expect(result).toEqual({ found: true, accessToken: "cli-token", machineId: "cli-machine" })
	})

	it("offers the paste box when both readers fail, naming the database", async () => {
		const result = await autoImportCursor(
			deps({
				readViaBinding: async () => {
					throw new Error("no binding")
				},
				readViaCli: async () => {
					throw new Error("no sqlite3")
				},
			}),
		)
		expect(result).toMatchObject({
			found: false,
			windowsManual: true,
			dbPath: "/home/u/.config/Cursor/User/globalStorage/state.vscdb",
		})
	})

	it("offers the paste box when the database reads but holds no tokens", async () => {
		const result = await autoImportCursor(
			deps({
				readViaBinding: async () => ({ accessToken: null, machineId: null }),
				readViaCli: async () => ({ accessToken: null, machineId: null }),
			}),
		)
		expect(result.found).toBe(false)
		expect(result).toMatchObject({ windowsManual: true })
	})

	it("falls through when a reader answers only half a credential", async () => {
		const result = await autoImportCursor(
			deps({
				readViaBinding: async () => ({ accessToken: "half", machineId: null }),
				readViaCli: async () => ({ accessToken: "full", machineId: "m" }),
			}),
		)
		expect(result).toMatchObject({ found: true, accessToken: "full" })
	})

	it("refuses a leftover config when the IDE is not installed", async () => {
		const read = vi.fn(async () => ({ accessToken: "t", machineId: "m" }))
		const result = await autoImportCursor(
			deps({ installed: async () => false, readViaBinding: read }),
		)
		expect(result.found).toBe(false)
		expect((result as { error: string }).error).toContain("does not appear to be installed")
		expect(read).not.toHaveBeenCalled()
	})

	it("reads normally when the IDE is installed", async () => {
		const result = await autoImportCursor(deps({ installed: async () => true }))
		expect(result.found).toBe(true)
	})

	it("does not probe for an installer on platforms that have no such check", async () => {
		const result = await autoImportCursor(deps({ installed: undefined }))
		expect(result.found).toBe(true)
	})

	it("answers not-found, not a crash, when the readability probe itself throws", async () => {
		const result = await autoImportCursor(
			deps({
				readable: async () => {
					throw new Error("EPERM")
				},
			}),
		)
		expect(result.found).toBe(false)
		expect((result as { error: string }).error).toContain("Cursor database not found")
	})
})

describe("cursorTokensComplete", () => {
	it("needs both halves", () => {
		expect(cursorTokensComplete({ accessToken: "a", machineId: "m" })).toBe(true)
		expect(cursorTokensComplete({ accessToken: "a", machineId: null })).toBe(false)
		expect(cursorTokensComplete({ accessToken: null, machineId: "m" })).toBe(false)
		expect(cursorTokensComplete({})).toBe(false)
	})
})

describe("cursorMissMessage", () => {
	it("lists the tried paths for a missing database", () => {
		expect(cursorMissMessage({ reason: "not-found", tried: ["/a", "/b"] })).toBe(
			"Cursor database not found. Checked locations:\n/a\n/b\n\nMake sure Cursor IDE is installed and opened at least once.",
		)
	})

	it("answers nothing for the paste box, which carries its own wording", () => {
		expect(cursorMissMessage({ reason: "manual", dbPath: "/a" })).toBe("")
	})
})
