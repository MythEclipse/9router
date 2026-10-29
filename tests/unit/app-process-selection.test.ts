import { describe, expect, it } from "vitest"

import { parseProcessRows, selectAppPids } from "../../apps/web/src/lib/appProcessSelection.ts"

describe("parseProcessRows", () => {
	it("reads pid and command", () => {
		expect(parseProcessRows("  123 next-server\n  456 bun\n")).toEqual([
			{ pid: 123, command: "next-server" },
			{ pid: 456, command: "bun" },
		])
	})

	it("keeps a command name containing spaces intact", () => {
		expect(parseProcessRows("  7 Google Chrome Helper")).toEqual([
			{ pid: 7, command: "Google Chrome Helper" },
		])
	})

	it("skips a header line instead of reading it as PID 0", () => {
		// A truncated or unlabelled read must not produce a kill target of 0.
		expect(parseProcessRows("PID COMMAND\n  9 bun\n")).toEqual([{ pid: 9, command: "bun" }])
	})

	it("ignores blank lines", () => {
		expect(parseProcessRows("\n\n")).toEqual([])
	})
})

describe("selectAppPids", () => {
	const SELF = 100

	it("selects a known executable", () => {
		expect(selectAppPids([{ pid: 200, command: "next-server" }], SELF)).toEqual([200])
	})

	it("never selects itself", () => {
		expect(selectAppPids([{ pid: SELF, command: "next-server" }], SELF)).toEqual([])
	})

	it("matches the basename when comm is a full path", () => {
		expect(selectAppPids([{ pid: 200, command: "/opt/9router/bin/9router" }], SELF)).toEqual([200])
	})

	it("does not select a shell whose arguments mention the project", () => {
		// The defect: `ps aux` was scanned for "9router", so a shell running
		// `cd /home/code/Project/9router && ...` matched and was killed. `comm` for
		// that process is `bash`, which is not one of ours.
		expect(selectAppPids([{ pid: 300, command: "bash" }], SELF)).toEqual([])
		expect(selectAppPids([{ pid: 301, command: "vim" }], SELF)).toEqual([])
		expect(selectAppPids([{ pid: 302, command: "rg" }], SELF)).toEqual([])
	})

	it("selects several of ours and skips the rest", () => {
		const rows = [
			{ pid: 1, command: "systemd" },
			{ pid: 200, command: "next-server" },
			{ pid: 300, command: "bash" },
			{ pid: 201, command: "cloudflared" },
		]
		expect(selectAppPids(rows, SELF)).toEqual([200, 201])
	})

	it("does not select a process whose name merely contains an app name", () => {
		// "not-next-server" is a different binary; the old substring test would have
		// matched it, as would any argument containing the name.
		expect(selectAppPids([{ pid: 400, command: "not-next-server" }], SELF)).toEqual([])
	})
})
