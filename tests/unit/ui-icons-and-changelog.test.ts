import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Sources are formatted without semicolons, so literals ending in ";"
 * never matched. Normalise both sides before comparing.
 */
const withoutSemicolons = (text: string) => text.replace(/;\s*$/gm, "").replace(/;\n/g, "\n")

const root = resolve(__dirname, "../..")
const modal = withoutSemicolons(
	readFileSync(resolve(root, "apps/web/src/shared/components/ChangelogModal.tsx"), "utf8"),
)
const globals = withoutSemicolons(
	readFileSync(resolve(root, "apps/web/src/app/globals.css"), "utf8"),
)
const layout = readFileSync(resolve(root, "apps/web/src/app/layout.tsx"), "utf8")

describe("changelog: every release card shows a commit count", () => {
	it("derives the count from the heading when present", () => {
		expect(modal).toMatch(/function countSectionCommits\(section\)/)
		expect(modal).toContain("section.commits != null")
	})

	it("falls back to counting body bullets for older entries", () => {
		expect(modal).toMatch(/function countBodyCommits\(body\)/)
		// one bullet is one changelog line; the hook writes one line per commit
		expect(modal).toContain("/^\\s*[-*]\\s+\\S/")
	})

	it("never appends a second count when the heading already has one", () => {
		expect(modal).toMatch(/function stripCommitCount\(title\)/)
		expect(modal).toContain('commits === 1 ? "commit" : "commits"')
		expect(modal).toMatch(/head = stripCommitCount\(head\)/)
	})

	it("sums every release merged into a day card", () => {
		expect(modal).toMatch(/group\.items\.reduce\(\(sum, s\) => sum \+ countSectionCommits\(s\), 0\)/)
	})

	it("new fork entries keep their '· N commits' heading format", () => {
		const cl = readFileSync(resolve(root, "CHANGELOG.md"), "utf8")
		const headings = cl.split("\n").filter((l) => /^# v\d/.test(l))
		expect(headings.length).toBeGreaterThan(10)
		const withCount = headings.filter((h) => /·\s*\d+\s+commits?/.test(h))
		// the changelog hook started writing counts; at least the newest entries have them
		expect(withCount.length).toBeGreaterThan(0)
	})
})

describe("icons are Lucide components, not an icon font", () => {
	const srcDir = resolve(root, "apps/web/src")
	const iconComponent = readFileSync(resolve(srcDir, "shared/components/Icon.tsx"), "utf8")
	const iconRegistry = readFileSync(resolve(srcDir, "shared/components/iconRegistry.ts"), "utf8")
	const iconSheet = readFileSync(resolve(srcDir, "shared/components/iconSheet.ts"), "utf8")

	const sourceFiles: string[] = []
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name)
			if (entry.isDirectory()) visit(full)
			else if (/\.(tsx?|jsx?)$/.test(entry.name)) sourceFiles.push(full)
		}
	}
	visit(srcDir)
	const sources = sourceFiles.map((file) => [file, readFileSync(file, "utf8")] as const)

	it("declares lucide-react as a dependency", () => {
		const pkg = JSON.parse(readFileSync(resolve(root, "apps/web/package.json"), "utf8"))
		expect(pkg.dependencies["lucide-react"]).toBeTruthy()
	})

	it("no longer ships the material-symbols font", () => {
		const pkg = JSON.parse(readFileSync(resolve(root, "apps/web/package.json"), "utf8"))
		expect(pkg.dependencies["material-symbols"]).toBeUndefined()
		expect(pkg.devDependencies?.["material-symbols"]).toBeUndefined()
		expect(existsSync(resolve(root, "apps/web/public/fonts/material-symbols-subset.woff2"))).toBe(false)
		expect(existsSync(resolve(root, "apps/web/scripts/build_icon_subset.py"))).toBe(false)
	})

	it("leaves no material-symbols markup or CSS behind", () => {
		const offenders = sources
			.filter(([, text]) => text.includes("material-symbols-outlined"))
			.map(([file]) => file.replace(srcDir, ""))
		expect(offenders, "convert these to <Icon />").toEqual([])
		const globals = readFileSync(resolve(srcDir, "app/globals.css"), "utf8")
		expect(globals).not.toContain("Material Symbols")
		expect(globals).not.toContain("material-symbols")
	})

	it("keeps the page from waiting on a font that no longer exists", () => {
		const layout = readFileSync(resolve(srcDir, "app/layout.tsx"), "utf8")
		expect(layout).not.toContain("fonts-loading")
		expect(layout).not.toContain("fonts-loaded")
		expect(layout).not.toContain("document.fonts.ready")
	})

	it("every icon name used in src/ resolves in the Icon registry", () => {
		// The registry is the single source of truth: a name that is not a key
		// renders nothing, which is a silent hole in the UI rather than an error.
		const registry = new Set(
			[...iconRegistry.matchAll(/^\t([a-z_0-9]+): LucideRaw\.[A-Za-z0-9]+,$/gm)].map((m) => m[1]),
		)
		expect(registry.size).toBeGreaterThan(100)
		const used = new Set<string>()
		for (const [, text] of sources) {
			for (const m of text.matchAll(/<Icon\b[^>]*?\bname="([^"]+)"/g)) used.add(m[1])
			for (const m of text.matchAll(/icon:\s*"([a-z_0-9]+)"/g)) used.add(m[1])
			for (const m of text.matchAll(/icon="([a-z_0-9]+)"/g)) used.add(m[1])
		}
		const missing = [...used].filter((name) => !registry.has(name)).sort()
		expect(missing, "add these to apps/web/src/shared/components/Icon.tsx").toEqual([])
	})

	it("the changelog icon sheet covers every name the modal can draw", () => {
		const sheetNames = new Set(
			[...iconSheet.matchAll(/^\t([a-z_0-9]+): "\d+",$/gm)].map((m) => m[1]),
		)
		expect(sheetNames.size).toBeGreaterThan(100)
		for (const icon of ["add", "check_circle", "cancel", "star", "help"]) {
			expect(sheetNames.has(icon), icon).toBe(true)
		}
		// The sheet is a data: URI so raw-HTML markdown needs no network fetch.
		expect(iconSheet).toContain("data:image/svg+xml")
		// Same 2-unit round-cap stroke as <Icon />, so both surfaces match.
		expect(iconSheet).toMatch(/stroke-width=.{0,2}2/)
	})

	it("renders an unknown icon as nothing rather than a literal word", () => {
		expect(iconComponent).toMatch(/if \(!Glyph\) return null/)
	})
})
