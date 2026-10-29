import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { devinBinCandidates, devinBinOverride } from "../../apps/api/src/domain/devin-binary.ts"

/**
 * Two callers resolve the Devin CLI: the executor that spawns it and the settings screen that
 * reports whether it is installed. open-sse is a standalone engine and cannot import from
 * `apps/api`, so the list exists twice. When they drift the dashboard says "not installed" while
 * the gateway spawns Devin fine, and nothing in either file points at the other — so the
 * duplication is asserted here instead of trusted.
 */

const EXECUTOR_PATH = "apps/web/open-sse/executors/devin-cli.ts"

describe("devinBinCandidates", () => {
	const posix = devinBinCandidates({ platform: "linux", home: "/home/u" })

	it("probes the destinations the installer and package managers actually use", () => {
		// `~/.local/share/devin/bin` is the official installer's path and was missing from the
		// settings screen before this list was shared.
		expect(posix).toContain("/home/u/.local/share/devin/bin/devin")
		expect(posix).toContain("/home/u/.local/bin/devin")
		expect(posix).toContain("/opt/homebrew/bin/devin")
		expect(posix).toContain("/usr/local/bin/devin")
	})

	it("orders the most specific install first", () => {
		expect(posix[0]).toBe("/home/u/.local/share/devin/bin/devin")
	})

	it("uses .exe names and LOCALAPPDATA on Windows", () => {
		const win = devinBinCandidates({
			platform: "win32",
			home: "C:/Users/u",
			localAppData: "D:/Local",
		})
		expect(win).toContain("D:/Local/devin/cli/bin/devin.exe")
		expect(win).toContain("C:/Users/u/scoop/shims/devin.exe")
		expect(win.every((entry) => entry.endsWith(".exe"))).toBe(true)
	})

	it("falls back to the home-relative LOCALAPPDATA when the variable is unset", () => {
		const win = devinBinCandidates({ platform: "win32", home: "C:/Users/u" })
		expect(win).toContain("C:/Users/u/AppData/Local/devin/cli/bin/devin.exe")
	})
})

describe("devinBinOverride", () => {
	it("returns a set override, trimmed", () => {
		expect(devinBinOverride({ CLI_DEVIN_BIN: "  /opt/devin  " })).toBe("/opt/devin")
	})

	it("returns null for unset or blank, so the candidate list runs", () => {
		expect(devinBinOverride({})).toBe(null)
		expect(devinBinOverride({ CLI_DEVIN_BIN: "   " })).toBe(null)
	})
})

describe("executor parity", () => {
	/** The body of `resolveDevinBin`, where the duplicated candidate list lives. */
	function executorBody(): string {
		const source = readFileSync(EXECUTOR_PATH, "utf-8")
		return source.slice(
			source.indexOf("function resolveDevinBin"),
			source.indexOf("// ─── ACP JSON-RPC helper"),
		)
	}

	it("lists the same locations in the executor that spawns devin", () => {
		const body = executorBody()
		const required = [
			'path.join(home, ".local", "share", "devin", "bin", "devin")',
			'path.join(home, ".devin", "bin", "devin")',
			'path.join(home, ".local", "bin", "devin")',
			'"/opt/homebrew/bin/devin"',
			'"/usr/local/bin/devin"',
			'"/usr/bin/devin"',
			'"devin.exe"',
			'"scoop"',
			'"Programs"',
		]
		const missing = required.filter((entry) => !body.includes(entry))
		// A location dropped here but kept in the domain list is the dashboard-disagrees-with-
		// gateway bug this whole arrangement exists to prevent.
		expect(missing).toEqual([])
	})

	it("still honours the explicit override before any candidate", () => {
		const body = executorBody()
		const overrideAt = body.indexOf("process.env.CLI_DEVIN_BIN")
		const candidatesAt = body.indexOf("for (const candidate of candidates)")
		expect(overrideAt).toBeGreaterThan(-1)
		expect(overrideAt).toBeLessThan(candidatesAt)
	})

	it("points at the domain list so the next reader knows it is duplicated on purpose", () => {
		expect(executorBody()).toContain("apps/api/src/domain/devin-binary.ts")
	})
})
