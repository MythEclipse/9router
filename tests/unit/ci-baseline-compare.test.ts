import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(__dirname, "../..")
const compareScript = resolve(root, "tests/__baseline__/compare-fails.mjs")

/**
 * A vitest JSON report with one suite. `tests` is [[name, status], ...].
 */
function reportFor(file, tests) {
	return {
		numTotalTests: tests.length,
		success: tests.every(([, status]) => status === "passed"),
		testResults: [
			{
				name: file,
				status: tests.some(([, status]) => status === "failed") ? "failed" : "passed",
				message: "",
				assertionResults: tests.map(([fullName, status]) => ({
					fullName,
					title: fullName.includes(" > ") ? fullName.split(" > ").pop() : fullName,
					status,
					failureMessages: status === "failed" ? [`${fullName} blew up`] : [],
				})),
			},
		],
	}
}

/** Run the comparison script and return { code, stdout } without throwing. */
function compare(report, knownLines) {
	const dir = mkdtempSync(join(tmpdir(), "compare-fails-"))
	const reportPath = join(dir, "vitest-results.json")
	const knownPath = join(dir, "known-fails.txt")
	writeFileSync(reportPath, JSON.stringify(report))
	writeFileSync(knownPath, knownLines.join("\n"))

	try {
		const stdout = execFileSync("node", [compareScript, reportPath, knownPath], { encoding: "utf8" })
		return { code: 0, stdout }
	} catch (error) {
		return { code: error.status, stdout: `${error.stdout || ""}${error.stderr || ""}` }
	}
}

// Relative, because the script only rebases absolute suite names onto the repo
// it lives in; a relative name is already in the shape known-fails.txt uses.
const FILE = "tests/unit/example.test.js"

describe("CI baseline comparison: only uncatalogued failures fail the job", () => {
	it("passes when the only failure is catalogued", () => {
		const report = reportFor(FILE, [
			["works", "passed"],
			["describe > breaks", "failed"],
		])
		const { code, stdout } = compare(report, [`tests/unit/example.test.js :: describe > breaks`])

		expect(code).toBe(0)
		expect(stdout).toContain("0 new failure(s)")
		expect(stdout).toContain("1 catalogued failure(s)")
	})

	it("fails with the test name when a failure is not catalogued", () => {
		const report = reportFor(FILE, [["describe > breaks", "failed"]])
		const { code, stdout } = compare(report, [])

		expect(code).toBe(1)
		expect(stdout).toContain("NEW tests/unit/example.test.js :: describe > breaks")
		expect(stdout).toContain("describe > breaks blew up")
	})

	it("matches a catalogued bare title as well as the full describe path", () => {
		const report = reportFor(FILE, [["describe > breaks", "failed"]])

		expect(compare(report, ["tests/unit/example.test.js :: breaks"]).code).toBe(0)
	})

	it("reports a catalogued failure that now passes as stale, without failing", () => {
		const report = reportFor(FILE, [["works", "passed"]])
		const { code, stdout } = compare(report, ["tests/unit/example.test.js :: works"])

		expect(code).toBe(0)
		expect(stdout).toContain("1 catalogued failure(s) now pass")
	})

	it("does not call a catalogued failure stale when its suite never ran", () => {
		const report = reportFor(FILE, [["works", "passed"]])
		const { stdout } = compare(report, ["tests/unit/other.test.js :: never ran"])

		expect(stdout).not.toContain("now pass")
	})

	it("treats a suite that failed to load as a failure with no test name", () => {
		const report = {
			numTotalTests: 0,
			success: false,
			testResults: [
				{ name: FILE, status: "failed", message: "Cannot find module", assertionResults: [] },
			],
		}
		const { code, stdout } = compare(report, [])

		expect(code).toBe(1)
		expect(stdout).toContain("NEW tests/unit/example.test.js :: (suite)")
	})

	it("accepts a catalogued suite that failed to load", () => {
		const report = {
			numTotalTests: 0,
			success: false,
			testResults: [
				{ name: FILE, status: "failed", message: "No test suite found", assertionResults: [] },
			],
		}

		expect(compare(report, [`tests/unit/example.test.js :: (suite)`]).code).toBe(0)
	})
})

describe("CI workflow wiring", () => {
	const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")

	it("builds and boots the standalone server so a guard-unavailable build fails CI", () => {
		expect(workflow).toContain("bun run build")
		expect(workflow).toContain("/api/health")
	})

	it("installs with bun so the lockfile and the build agree", () => {
		expect(workflow).toContain("bun install --frozen-lockfile")
		expect(workflow).not.toContain("pnpm")
	})

	// The runtime loads src/dashboardGuard.ts outside the Next bundle, so bun has
	// to resolve its "@/lib" imports itself — and bun reads those aliases from
	// tsconfig.json, not from a bundler config. Leaving tsconfig out of the
	// payload boots a live host with a dead auth guard and a permanent 503.
	it("ships tsconfig.json with the release so bun resolves the path aliases", () => {
		// The payload is assembled over several `cp` lines and the workflow now
		// copies from apps/web, so requiring tsconfig.json on the same line as
		// custom-server.js asserted the line layout rather than the payload.
		const releaseBlock = workflow.slice(workflow.indexOf("9router-release"))
		expect(releaseBlock).toContain("custom-server.js")
		expect(releaseBlock).toContain("tsconfig.json")
	})

	it("keeps the image publish manual", () => {
		expect(workflow).toContain("workflow_dispatch")
	})
})
