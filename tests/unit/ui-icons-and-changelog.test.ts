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

describe("icon subset: 114 KB instead of the 3.96 MB package font", () => {
	const subset = resolve(root, "apps/web/public/fonts/material-symbols-subset.woff2")
	const list = resolve(root, "apps/web/public/fonts/material-symbols-glyphs.txt")

	it("ships a subset well under a quarter MB", () => {
		expect(existsSync(subset)).toBe(true)
		expect(statSync(subset).size).toBeLessThan(250_000)
		expect(statSync(subset).size).toBeGreaterThan(10_000)
	})

	it("covers the icons the menu depends on", () => {
		const names = new Set(
			readFileSync(list, "utf8")
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean),
		)
		expect(names.size).toBeGreaterThanOrEqual(140)
		for (const icon of ["grid_view", "palette", "history", "power_settings_new", "logout"]) {
			expect(names.has(icon)).toBe(true)
		}
	})

	it("serves exactly one face, the subset, and never the 3.96 MB package font", () => {
		expect(globals).toContain('url("/fonts/material-symbols-subset.woff2")')
		const faces = globals.split("@font-face").slice(1)
		// A second face pointing into node_modules is what made every build emit the
		// full font into .next/static/media. The coverage test below is the safety
		// net that fallback used to be, so the face count is pinned at one.
		expect(faces).toHaveLength(1)
		expect(faces[0]).toContain("material-symbols-subset.woff2")
		expect(globals).not.toContain("node_modules/material-symbols")
	})

	it("covers every icon src/ actually renders", () => {
		// The subset is only safe to serve alone while it is exhaustive. Scanning the
		// same three shapes the generator scans keeps the two in step: adding an icon
		// to a component fails here until build_icon_subset.py is re-run.
		const shipped = new Set(
			readFileSync(list, "utf8")
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean),
		)
		const patterns = [
			/icon:\s*"([a-z_0-9]+)"/g,
			/icon="([a-z_0-9]+)"/g,
			/material-symbols-outlined[^>]*>\s*([a-z_0-9]+)\s*</g,
		]
		const used = new Set<string>()
		const visit = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name)
				if (entry.isDirectory()) visit(full)
				else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
					const text = readFileSync(full, "utf8")
					for (const pattern of patterns) {
						for (const match of text.matchAll(pattern)) used.add(match[1])
					}
				}
			}
		}
		visit(resolve(root, "apps/web/src"))
		const missing = [...used].filter((icon) => !shipped.has(icon)).sort()
		expect(missing, "re-run apps/web/scripts/build_icon_subset.py").toEqual([])
	})

	it("enables the rlig feature the font actually ships", () => {
		// Quote style and line wrapping are formatting; the two features are the
		// property under test.
		expect(globals.replace(/["']/g, "'").replace(/\s+/g, " ")).toMatch(
			/font-feature-settings: 'liga' 1,\s*'rlig' 1/,
		)
	})

	it("reveals icons from fonts.ready with a hard fallback, never hanging at 0", () => {
		expect(layout).toContain("document.fonts.ready")
		expect(layout).toMatch(/setTimeout\(f,\s*1500\)/)
		// the gate class is always added: ready, catch, and the timer all call f
		expect(layout).toMatch(/r\.classList\.remove\('fonts-loading'\)/)
	})
})
