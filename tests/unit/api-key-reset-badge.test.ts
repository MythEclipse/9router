import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(__dirname, "../..")
const page = readFileSync(
	resolve(root, "apps/web/src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.tsx"),
	"utf8",
)

describe("key card: one reset badge, the one that counts down", () => {
	it("no longer prints the static interval", () => {
		expect(page).not.toMatch(/Reset: every/)
	})

	it("still renders the live countdown for a capped key on a reset window", () => {
		// The badge is now gated by a precomputed flag and the clock arrives as a
		// prop, so the old single-line regex could not match. Assert the three
		// facts that matter instead of the exact JSX layout.
		expect(page).toMatch(/const hasResetCountdown = keys\.some\(/)
		expect(page).toMatch(/limitCapOf\(key\) > 0/)
		expect(page).toMatch(/<ResetCountdown[\s\S]{0,200}?resetInterval=\{key\.resetInterval\}/)
		expect(page).toMatch(/<ResetCountdown[\s\S]{0,200}?lastResetAt=\{key\.lastResetAt\}/)
	})

	it("labels the countdown as the next reset", () => {
		const countdown = page.slice(
			page.indexOf("function ResetCountdown"),
			page.indexOf("ResetCountdown.propTypes"),
		)
		expect(countdown).toMatch(/Next reset: \$\{formatDuration\(remaining\)\}/)
		expect(countdown).toMatch(/Resetting\.\.\./)
	})

	it("ticks, so the number moves without a reload", () => {
		const countdown = page.slice(
			page.indexOf("function ResetCountdown"),
			page.indexOf("ResetCountdown.propTypes"),
		)
		expect(page).toMatch(/const now = useNow\(hasResetCountdown\)/)
	})

	it("hides itself for a key with no reset window", () => {
		const countdown = page.slice(
			page.indexOf("function ResetCountdown"),
			page.indexOf("ResetCountdown.propTypes"),
		)
		expect(countdown).toMatch(/if \(!resetInterval \|\| resetInterval === "never"\) return null/)
	})
})
