import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The live stream reads one table for both finished rows and lifecycle markers
 * (the PENDING row opened when a request starts, the FAILED row when it dies).
 *
 * Only the finished row carried the alias, so while a request was in flight its
 * marker held meta={} and the dashboard showed the requested name — a combo —
 * until the terminal row replaced it. That produced a flash of the combo name on
 * every single request, which reads as the model "blinking" between the real
 * target and the alias.
 *
 * Both row kinds now carry the same pair: `model` = the name the caller asked
 * for, `meta.resolvedModel` = the upstream that served it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const repo = readFileSync(join(REPO_ROOT, "packages/db/src/repos/usageRepo.ts"), "utf8")
const chatCore = readFileSync(join(REPO_ROOT, "apps/web/open-sse/handlers/chatCore.ts"), "utf8")

describe("lifecycle rows keep the resolved model", () => {
	it("accepts an alias on the lifecycle entry", () => {
		const entry = repo.match(/interface RequestLogEntry \{[\s\S]*?\n\}/)
		expect(entry).not.toBeNull()
		expect(entry?.[0]).toMatch(/requestedModel\?: string \| null\s*;?/)
	})

	it("hands saveRequestUsage the real model plus the alias", () => {
		// Passing only `model: trackedModel` stored the combo with meta={}, which is
		// the exact row shape that made the dashboard regress to the combo name.
		expect(repo).toMatch(/const realModel = requestedModel \|\| model\s*;?/)
		expect(repo).toMatch(/const aliasModelName = requestedModel \? model : undefined\s*;?/)
		expect(repo).toContain("requestedModel: aliasModelName,")
	})

	it("threads the alias from every lifecycle call site in chatCore", () => {
		// `trackedModel` is the requested (combo) name; `model` is the real target.
		//
		// Scanned as whole call expressions, not per line: the formatter spreads
		// these calls over several lines, so a line filter matches nothing and
		// the assertion would silently pass on zero call sites.
		const lifecycleCalls = [...chatCore.matchAll(/appendRequestLog\(\{[\s\S]*?\}\)/g)]
			.map((m) => m[0])
			.filter((call) => /status:\s*["'](?:PENDING|FAILED)["']/.test(call))
		expect(lifecycleCalls.length).toBeGreaterThan(0)
		for (const call of lifecycleCalls) {
			expect(call).toMatch(/requestedModel:\s*model/)
		}
	})

	it("also threads the alias through the shared appendLog helper", () => {
		// Same call, whitespace-insensitive for the reason above.
		const appendLog = chatCore.match(/appendRequestLog\(\{[\s\S]*?\}\)/g) ?? []
		const helperCall = appendLog.find(
			(call) => /model:\s*trackedModel/.test(call) && /requestedModel:\s*model/.test(call),
		)
		expect(helperCall).toBeDefined()
	})
})
