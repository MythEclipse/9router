/**
 * The four rules that decide what a CLI tool's settings write contains.
 *
 * Module under test: `apps/api/src/domain/cli-tool-settings.ts`. No test file is named after it. It is
 * reached only through `tests/unit/use-case-tool-settings.test.ts`, which exercises the use-case in
 * `application/cli-tools/manage-tool-settings.ts`; four of its exports appear in no test file at all:
 * `normaliseBaseUrl`, `pointsAtThisInstall`, `readLimit`, `isWritableApiKey`.
 *
 * Why this file exists — each of the four decides something an operator will notice:
 *
 * - `readLimit` clamps a context window sent by a form. It swallows nonsense into the default, so
 *   "invalid" and "absent" are indistinguishable to the caller; the symptom of a bug here is a model
 *   quietly configured with someone else's window, not an error.
 * - `isWritableApiKey` decides whether a key is written. The card sends its placeholder for an
 *   untouched field, and a config holding `sk_9router` looks configured while every request fails
 *   authorisation — the worst of both states.
 * - `normaliseBaseUrl` rewrites the URL the operator typed, and the two spellings must not accumulate.
 * - `pointsAtThisInstall` drives a "needs configuring" badge; a false positive here hides the fact
 *   that a tool is still pointed at its vendor.
 *
 * User's verbatim instruction: "lanjut lupakan prompt saya sebelumnya tentang writeup karena salah
 * kirim" — continue the work, and disregard the earlier write-up instruction, sent by mistake.
 */

import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	isWritableApiKey,
	MAX_CONTEXT_WINDOW,
	MAX_MAX_TOKENS,
	normaliseBaseUrl,
	pointsAtThisInstall,
	readLimit,
	THIS_INSTALL_HOSTS,
} from "9router-api/domain/cli-tool-settings"
import { describe, expect, it } from "vitest"

describe("a numeric limit sent by a form", () => {
	it("keeps a value inside the range", () => {
		expect(readLimit(64000, DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW)).toBe(64000)
	})

	it("keeps a numeric string, because a form field arrives as text", () => {
		expect(readLimit("64000", DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW)).toBe(64000)
	})

	it("falls back when the value is missing, rather than writing zero", () => {
		for (const value of [undefined, null, ""]) {
			expect(readLimit(value, DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW)).toBe(DEFAULT_CONTEXT_WINDOW)
		}
	})

	it("falls back when the value is not a number at all", () => {
		// `Number(true)` is 1 and `Number([5])` is 5, so coercion alone would write a one-token
		// context window for a boolean field. A limit is a number or a numeric string, nothing else.
		for (const value of ["abc", {}, [], [5], true, false, "64k"]) {
			const limit = readLimit(value, DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW)
			expect(limit, `${JSON.stringify(value)} must not be coerced`).toBe(DEFAULT_CONTEXT_WINDOW)
		}
	})

	it("falls back when the value is zero or negative, which no model accepts", () => {
		for (const value of [0, -1, -0.5, "-200000"]) {
			expect(readLimit(value, DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW)).toBe(DEFAULT_CONTEXT_WINDOW)
		}
	})

	it("falls back when the value exceeds the maximum, rather than clamping to it", () => {
		// Clamping would claim the model supports 2M when the operator asked for 10M. The
		// default is the honest answer: it is a number the tool documents.
		expect(readLimit(MAX_CONTEXT_WINDOW + 1, DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW)).toBe(
			DEFAULT_CONTEXT_WINDOW,
		)
		expect(readLimit(MAX_MAX_TOKENS * 10, DEFAULT_MAX_TOKENS, MAX_MAX_TOKENS)).toBe(
			DEFAULT_MAX_TOKENS,
		)
	})

	it("accepts exactly the maximum", () => {
		expect(readLimit(MAX_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW)).toBe(
			MAX_CONTEXT_WINDOW,
		)
	})

	it("falls back on Infinity and NaN instead of writing them", () => {
		expect(readLimit(Number.POSITIVE_INFINITY, 1, 10)).toBe(1)
		expect(readLimit(Number.NaN, 1, 10)).toBe(1)
	})
})

describe("whether a key is worth writing", () => {
	it("writes a real key", () => {
		expect(isWritableApiKey("sk-real-key-123")).toBe(true)
	})

	it("refuses the card's placeholder, because a config holding it looks configured and is not", () => {
		expect(isWritableApiKey("sk_9router")).toBe(false)
	})

	it("refuses blank and whitespace-only fields", () => {
		for (const value of ["", "   ", "\t", "\n"]) {
			expect(isWritableApiKey(value)).toBe(false)
		}
	})

	it("refuses the placeholder even when it arrives padded", () => {
		expect(isWritableApiKey("  sk_9router  ")).toBe(false)
	})

	it("a key that merely contains the placeholder is still a real key", () => {
		expect(isWritableApiKey("sk_9router_live_abc123")).toBe(true)
	})
})

describe("the base URL in the spelling a tool expects", () => {
	it("appends /v1 by default", () => {
		expect(normaliseBaseUrl("http://localhost:20128")).toBe("http://localhost:20128/v1")
	})

	it("does not append it twice, which a second save would otherwise do", () => {
		expect(normaliseBaseUrl("http://localhost:20128/v1")).toBe("http://localhost:20128/v1")
	})

	it("strips trailing slashes first, so `host/v1/` lands on the same value as `host`", () => {
		expect(normaliseBaseUrl("http://localhost:20128/")).toBe("http://localhost:20128/v1")
		expect(normaliseBaseUrl("http://localhost:20128/v1/")).toBe("http://localhost:20128/v1")
		expect(normaliseBaseUrl("http://localhost:20128///")).toBe("http://localhost:20128/v1")
	})

	it("leaves the URL alone when the tool wants no suffix", () => {
		expect(normaliseBaseUrl("http://localhost:20128", "without-v1")).toBe("http://localhost:20128")
	})

	it("removes a /v1 already present when the tool wants no suffix", () => {
		expect(normaliseBaseUrl("http://localhost:20128/v1", "without-v1")).toBe("http://localhost:20128")
	})

	it("trims surrounding whitespace, because a pasted URL carries it", () => {
		expect(normaliseBaseUrl("  http://localhost:20128  ")).toBe("http://localhost:20128/v1")
	})

	it("is idempotent, so reading and re-saving cannot drift", () => {
		for (const url of ["http://h:1", "http://h:1/v1", "http://h:1/"]) {
			const once = normaliseBaseUrl(url)
			expect(normaliseBaseUrl(once)).toBe(once)
			const bare = normaliseBaseUrl(url, "without-v1")
			expect(normaliseBaseUrl(bare, "without-v1")).toBe(bare)
		}
	})
})

describe("whether a stored URL already points at this install", () => {
	it("recognises each host that identifies this install", () => {
		for (const host of THIS_INSTALL_HOSTS) {
			expect(pointsAtThisInstall(`http://${host}:20128/v1`, THIS_INSTALL_HOSTS)).toBe(true)
		}
	})

	it("compares without regard to case, so a hand-typed LOCALHOST still counts", () => {
		expect(pointsAtThisInstall("http://LOCALHOST:20128/v1", THIS_INSTALL_HOSTS)).toBe(true)
	})

	it("tolerates surrounding whitespace", () => {
		expect(pointsAtThisInstall("  http://localhost:20128  ", THIS_INSTALL_HOSTS)).toBe(true)
	})

	it("says no to a vendor URL, which is the whole point of the badge", () => {
		expect(pointsAtThisInstall("https://api.anthropic.com/v1", THIS_INSTALL_HOSTS)).toBe(false)
	})

	it("says no to a missing or non-string value", () => {
		for (const value of [undefined, null, 42, {}, ""]) {
			expect(pointsAtThisInstall(value, THIS_INSTALL_HOSTS)).toBe(false)
		}
	})
})
