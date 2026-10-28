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
const repo = readFileSync(join(REPO_ROOT, "src/lib/db/repos/usageRepo.ts"), "utf8")
const chatCore = readFileSync(join(REPO_ROOT, "open-sse/handlers/chatCore.ts"), "utf8")

describe("lifecycle rows keep the resolved model", () => {
	it("accepts an alias on the lifecycle entry", () => {
		const entry = repo.match(/interface RequestLogEntry \{[\s\S]*?\n\}/)
		expect(entry).not.toBeNull()
		expect(entry?.[0]).toContain("requestedModel?: string | null;")
	})

	it("hands saveRequestUsage the real model plus the alias", () => {
		// Passing only `model: trackedModel` stored the combo with meta={}, which is
		// the exact row shape that made the dashboard regress to the combo name.
		expect(repo).toContain("const realModel = requestedModel || model;")
		expect(repo).toContain("const aliasModelName = requestedModel ? model : undefined;")
		expect(repo).toContain("requestedModel: aliasModelName,")
	})

	it("threads the alias from every lifecycle call site in chatCore", () => {
		// `trackedModel` is the requested (combo) name; `model` is the real target.
		const lifecycleLines = chatCore
			.split("\n")
			.filter((l) => l.includes("appendRequestLog(") && l.includes("status:"))
		expect(lifecycleLines.length).toBeGreaterThan(0)
		for (const line of lifecycleLines) {
			expect(line).toContain("requestedModel: model")
		}
	})

	it("also threads the alias through the shared appendLog helper", () => {
		expect(chatCore).toContain(
			"appendRequestLog({ model: trackedModel, provider, connectionId, requestedModel: model,",
		)
	})
})
