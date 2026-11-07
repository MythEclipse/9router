import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { rotateOpencodeSession, stableSessionId } from "open-sse/executors/opencode.js"
import { describe, expect, it } from "vitest"
import { isOpencodeFreeUsageSpent } from "../../apps/web/src/sse/handlers/chat/accountAttempt.ts"

// process.cwd() in a test run is tests/, so anchor on the file instead.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8")

describe("opencode session rotation on FreeUsageLimitError", () => {
	it("mints a fresh canonical session per rotate call", () => {
		const first = stableSessionId({})
		const second = rotateOpencodeSession({})
		expect(second).toMatch(/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
		expect(second).not.toBe(first)
		// The fresh session becomes the new stable one.
		expect(stableSessionId({})).toBe(second)
	})

	it("rotates only that identity, not the others", () => {
		const credsA = { connectionId: "proxy:aaa" }
		const credsB = { connectionId: "proxy:bbb" }
		const sessionA = stableSessionId(credsA)
		const sessionB = stableSessionId(credsB)
		const rotatedA = rotateOpencodeSession(credsA)
		expect(rotatedA).not.toBe(sessionA)
		expect(stableSessionId(credsB)).toBe(sessionB)
	})

	// The account-fallback loop moved out of chat.ts into
	// sse/handlers/chat/accountAttempt.ts, so the invariant is checked against the
	// module that now owns it rather than by grepping chat.ts.
	it("the chat fallback rotates before moving to the next account", () => {
		const attempt = read("apps/web/src/sse/handlers/chat/accountAttempt.ts")
		const chat = read("apps/web/src/sse/handlers/chat.ts")
		expect(attempt).toContain("rotateOpencodeSession")
		expect(attempt).toMatch(/free\\s\*usage\\s\*limit/)
		// The rotation is keyed on the spent-session signature only...
		expect(
			isOpencodeFreeUsageSpent("opencode", 429, "FreeUsageLimitError: free usage limit reached"),
		).toBe(true)
		expect(isOpencodeFreeUsageSpent("opencode", 429, "rate limited")).toBe(false)
		expect(isOpencodeFreeUsageSpent("anthropic", 429, "free usage limit reached")).toBe(false)
		// ...and the account is excluded in the caller's loop, as before.
		expect(chat).toContain("excludeConnectionIds.add(failure.connectionId)")
	})
})
