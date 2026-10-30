import { describe, expect, test } from "bun:test"
import type {
	DevinInstallPort,
	DevinVersionPort,
} from "../../apps/api/src/application/cli-tools/read-devin-status.ts"
import { readDevinStatus } from "../../apps/api/src/application/cli-tools/read-devin-status.ts"

/**
 * The only decision in this flow is the probing order, and the only failure worth tolerating is
 * a binary that exists but will not answer `--version`. Both are unreachable through a real
 * machine without having Devin installed one way and not the other, which is why they arrive
 * as ports.
 */

const install = (init: {
	onPath?: boolean
	candidates?: string[]
	present?: string[]
	fail?: boolean
}): DevinInstallPort & { probed: string[] } => {
	const probed: string[] = []
	return {
		probed,
		onPath: async () => {
			if (init.fail) throw new Error("spawn failed")
			probed.push("PATH")
			return init.onPath ?? false
		},
		candidates: () => init.candidates ?? [],
		exists: async (path) => {
			probed.push(path)
			return (init.present ?? []).includes(path)
		},
	}
}

const version = (value: string | null): DevinVersionPort => ({ version: async () => value })

describe("where devin was found", () => {
	test("PATH wins, because that is the binary the operator's shell would run", async () => {
		const port = install({
			onPath: true,
			candidates: ["/opt/devin"],
			present: ["/opt/devin"],
		})
		const answer = await readDevinStatus(port, version("1.2.3"))
		expect(answer.body.source).toBe("path")
		// The installer paths are not probed at all once PATH answers.
		expect(port.probed).toEqual(["PATH"])
	})

	test("a binary only in an installer path reports that path", async () => {
		const port = install({ candidates: ["/a/devin", "/b/devin"], present: ["/b/devin"] })
		const answer = await readDevinStatus(port, version("1.2.3"))
		expect(answer.body.source).toBe("/b/devin")
	})

	test("candidates are tried in the order given, and probing stops at the first hit", async () => {
		const port = install({
			candidates: ["/a/devin", "/b/devin", "/c/devin"],
			present: ["/a/devin", "/c/devin"],
		})
		await readDevinStatus(port, version(null))
		expect(port.probed).toEqual(["PATH", "/a/devin"])
	})

	test("nothing anywhere is installed: false, with the install url and what to run", async () => {
		const answer = await readDevinStatus(install({ candidates: ["/a/devin"] }), version("1.2.3"))
		expect(answer.status).toBe(200)
		expect(answer.body.installed).toBe(false)
		expect(answer.body.installUrl).toBe("https://cli.devin.ai")
		expect(String(answer.body.message)).toContain("devin auth login")
	})
})

describe("what an installed devin reports", () => {
	test("the version, first line only", async () => {
		const answer = await readDevinStatus(install({ onPath: true }), version("1.2.3"))
		expect(answer.body.installed).toBe(true)
		expect(answer.body.version).toBe("1.2.3")
		expect(answer.body.source).toBe("path")
	})

	test("an installed binary that cannot report a version is still installed", async () => {
		const answer = await readDevinStatus(install({ onPath: true }), version(null))
		expect(answer.status).toBe(200)
		expect(answer.body.installed).toBe(true)
		expect(answer.body.version).toBeNull()
	})

	test("the message still tells the operator to log in", async () => {
		const answer = await readDevinStatus(install({ onPath: true }), version("1.0.0"))
		expect(String(answer.body.message)).toContain("devin auth login")
	})

	test("a probe that throws is a 500 with the reason, not a claim of not-installed", async () => {
		const answer = await readDevinStatus(install({ fail: true }), version("1.0.0"))
		expect(answer.status).toBe(500)
		expect(answer.body.error).toBe("spawn failed")
	})
})
