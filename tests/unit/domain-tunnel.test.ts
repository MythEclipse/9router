import { describe, expect, it } from "vitest"
import {
	DNS_WARMUP_DELAY_MS,
	installFailureOf,
	installNeedsPassword,
	installPasswordOf,
	STATUS_CACHE_TTL_MS,
	statusIsFresh,
} from "../../apps/api/src/domain/tunnel.ts"

describe("statusIsFresh", () => {
	it("reuses an entry inside the window", () => {
		expect(statusIsFresh(1_000, 1_000)).toBe(true)
		expect(statusIsFresh(1_000, 1_000 + STATUS_CACHE_TTL_MS - 1)).toBe(true)
	})

	it("refetches at the edge, because the window is a maximum not a minimum", () => {
		expect(statusIsFresh(1_000, 1_000 + STATUS_CACHE_TTL_MS)).toBe(false)
	})

	it("never reuses an empty cache", () => {
		expect(statusIsFresh(0, 0)).toBe(false)
		expect(statusIsFresh(-1, 0)).toBe(false)
	})

	it("treats a clock that moved backwards as stale, rather than freezing the panel", () => {
		expect(statusIsFresh(5_000, 1_000)).toBe(false)
	})
})

describe("installNeedsPassword", () => {
	it("does not ask Windows for a sudo password it has no way to use", () => {
		expect(installNeedsPassword("win32", false)).toBe(false)
	})

	it("does not ask Homebrew on macOS", () => {
		expect(installNeedsPassword("darwin", true)).toBe(false)
	})

	it("asks macOS without Homebrew, and every other platform", () => {
		expect(installNeedsPassword("darwin", false)).toBe(true)
		expect(installNeedsPassword("linux", false)).toBe(true)
		expect(installNeedsPassword("linux", true)).toBe(true)
	})
})

describe("installPasswordOf", () => {
	it("prefers what the operator typed, because they typed it to replace the cached one", () => {
		expect(installPasswordOf({ sent: " typed ", cached: "cached", required: true })).toEqual({
			password: "typed",
		})
	})

	it("falls back to the cache so a second attempt works", () => {
		expect(installPasswordOf({ sent: "", cached: "cached", required: true })).toEqual({
			password: "cached",
		})
	})

	it("refuses when a password is required and neither source has one", () => {
		expect(installPasswordOf({ sent: "", cached: null, required: true })).toEqual({
			error: "Sudo password is required",
		})
		expect(installPasswordOf({ sent: "   ", cached: "  ", required: true })).toEqual({
			error: "Sudo password is required",
		})
	})

	it("proceeds without a password where none is needed", () => {
		expect(installPasswordOf({ sent: undefined, cached: null, required: false })).toEqual({
			password: "",
		})
	})

	it("ignores a non-string password rather than installing with an object", () => {
		expect(installPasswordOf({ sent: { a: 1 }, cached: "cached", required: true })).toEqual({
			password: "cached",
		})
	})
})

describe("installFailureOf", () => {
	it("names the password when sudo refused it, instead of quoting 'Sorry, try again.'", () => {
		expect(installFailureOf("sudo: Sorry, try again.")).toBe("Wrong sudo password")
		expect(installFailureOf("incorrect password")).toBe("Wrong sudo password")
	})

	it("passes any other failure through unchanged", () => {
		expect(installFailureOf("network unreachable")).toBe("network unreachable")
	})

	it("has something to say when the error carried no message", () => {
		expect(installFailureOf(undefined)).toBe("Install failed")
	})
})

describe("DNS_WARMUP_DELAY_MS", () => {
	it("is long enough to cover propagation but short enough to sit through", () => {
		expect(DNS_WARMUP_DELAY_MS).toBeGreaterThan(1_000)
		expect(DNS_WARMUP_DELAY_MS).toBeLessThan(30_000)
	})
})
