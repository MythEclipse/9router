import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Sources are formatted without semicolons, so literals ending in ";"
 * never matched. Normalise both sides before comparing.
 */
const withoutSemicolons = (text: string) => text.replace(/;\s*$/gm, "").replace(/;\n/g, "\n")

const root = resolve(__dirname, "../..")
const read = (p) => withoutSemicolons(readFileSync(resolve(root, p), "utf8"))

describe("debug navigation access", () => {
	it("restricts debug navigation to administrator sessions or advanced permissions", () => {
		const sidebar = read("apps/web/src/shared/components/Sidebar.tsx")
		expect(sidebar).toContain("if (!sessionReady) return false")
		expect(sidebar).toContain("if (!isApiKeyUser) return true")
		expect(sidebar).toContain("return permissions.manageAdvanced")
	})
})

describe("usage empty state", () => {
	it("has no Get an API key call to action in Recent Requests", () => {
		const usage = read("apps/web/src/shared/components/UsageStats.tsx")
		expect(usage).not.toContain("Get an API key")
		// The empty state must still say something. Pin the intent (an explicit
		// "no X yet/recorded" message) rather than one exact string, which drifted
		// from "No requests yet." to "No requests logged for this timeframe.".
		expect(usage).toMatch(/No (requests|usage)[^"'<]*\b(yet|timeframe|recorded)/i)
	})
})

describe("custom model owned_by", () => {
	it("the modal collects an optional owned by label", () => {
		const modal = read(
			"apps/web/src/app/(dashboard)/dashboard/providers/[id]/AddCustomModelModal.tsx",
		)
		expect(modal).toContain("setOwnedBy")
		expect(modal).toContain("ownedBy.trim()")
		expect(modal).toContain("(optional)")
	})

	it("the label travels from the modal to the API", () => {
		const page = read("apps/web/src/app/(dashboard)/dashboard/providers/[id]/page.tsx")
		expect(page).toContain("...(ownedBy ? { ownedBy } : {})")
		const route = read("apps/web/src/app/api/models/custom/route.ts")
		expect(route).toContain('ownedBy: typeof ownedBy === "string" ? ownedBy.trim() : ""')
		const repo = read("packages/db/src/repos/aliasRepo.ts")
		expect(repo).toContain("ownedBy")
	})

	it("the model list publishes it, defaulting to the provider alias", () => {
		const v1 = read("apps/web/src/app/api/v1/models/route.ts")
		expect(v1).toContain("owned_by: customModel.ownedBy || providerAlias,")
		// The connected path merges custom ids and must publish the label there too.
		expect(v1).toContain("owned_by: customOwnedByById.get(modelId) || outputAlias,")
	})
})
