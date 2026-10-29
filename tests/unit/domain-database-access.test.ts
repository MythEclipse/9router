import { describe, expect, it } from "vitest"
import {
	bodyTooLarge,
	exportAccessOf,
	exportSectionsOf,
	importAccessOf,
	importJobProgress,
	isCliRequest,
	MAX_IMPORT_BYTES,
	pollAccessOf,
	presentedBy,
} from "../../apps/api/src/domain/database-access.ts"

describe("isCliRequest", () => {
	it("trusts any present header", () => {
		expect(isCliRequest("anything")).toBe(true)
	})

	it("does not trust an absent or empty header", () => {
		expect(isCliRequest(null)).toBe(false)
		expect(isCliRequest(undefined)).toBe(false)
		expect(isCliRequest("")).toBe(false)
	})
})

describe("presentedBy", () => {
	it("reads all three headers", () => {
		const headers = new Map([
			["x-9r-cli-token", "abc"],
			["x-9r-password", "pw"],
			["x-9r-poll-token", "poll"],
		])
		expect(presentedBy({ get: (n) => headers.get(n) ?? null })).toEqual({
			cli: true,
			password: "pw",
			pollToken: "poll",
		})
	})

	it("reports a request that presented nothing", () => {
		expect(presentedBy({ get: () => null })).toEqual({
			cli: false,
			password: null,
			pollToken: null,
		})
	})
})

describe("exportAccessOf", () => {
	it("lets a summary through with no credential at all", () => {
		expect(exportAccessOf({ summary: true, cli: false, password: null })).toEqual({
			kind: "summary",
		})
	})

	it("prefers the summary exemption over a password that was also sent", () => {
		expect(exportAccessOf({ summary: true, cli: false, password: "pw" }).kind).toBe("summary")
	})

	it("treats a CLI request as already proven", () => {
		expect(exportAccessOf({ summary: false, cli: true, password: null }).kind).toBe("cli")
	})

	it("requires a password otherwise", () => {
		expect(exportAccessOf({ summary: false, cli: false, password: "pw" })).toEqual({
			kind: "password",
			password: "pw",
		})
	})

	it("still asks for a password when none was sent", () => {
		expect(exportAccessOf({ summary: false, cli: false, password: null })).toEqual({
			kind: "password",
			password: null,
		})
	})
})

describe("importAccessOf", () => {
	it("treats a CLI request as already proven", () => {
		expect(importAccessOf({ cli: true, password: null }).kind).toBe("cli")
	})

	it("requires a password otherwise", () => {
		expect(importAccessOf({ cli: false, password: "pw" }).kind).toBe("password")
	})
})

describe("pollAccessOf", () => {
	it("offers the poll token, not only the password", () => {
		expect(pollAccessOf({ cli: false, pollToken: "t", password: null })).toEqual({
			kind: "poll",
			pollToken: "t",
			password: null,
		})
	})

	it("keeps the password as a fallback for older jobs", () => {
		expect(pollAccessOf({ cli: false, pollToken: null, password: "pw" })).toEqual({
			kind: "poll",
			pollToken: null,
			password: "pw",
		})
	})

	it("treats a CLI request as already proven", () => {
		expect(pollAccessOf({ cli: true, pollToken: null, password: null }).kind).toBe("cli")
	})
})

describe("exportSectionsOf", () => {
	it("answers null for no parameter, meaning everything", () => {
		expect(exportSectionsOf(null)).toBeNull()
		expect(exportSectionsOf("")).toBeNull()
	})

	it("splits and trims a list", () => {
		expect(exportSectionsOf(" keys , combos ")).toEqual(["keys", "combos"])
	})

	it("drops blank entries", () => {
		expect(exportSectionsOf("keys,,combos")).toEqual(["keys", "combos"])
	})

	it("answers null for a list of only blanks, meaning everything", () => {
		expect(exportSectionsOf(",,")).toBeNull()
	})
})

describe("bodyTooLarge", () => {
	it("allows a body at the limit", () => {
		expect(bodyTooLarge(String(MAX_IMPORT_BYTES))).toBe(false)
	})

	it("refuses one byte over", () => {
		expect(bodyTooLarge(String(MAX_IMPORT_BYTES + 1))).toBe(true)
	})

	it("does not refuse an unstated size, which chunked uploads omit", () => {
		expect(bodyTooLarge(null)).toBe(false)
	})

	it("does not refuse a garbage size", () => {
		expect(bodyTooLarge("not-a-number")).toBe(false)
	})
})

describe("importJobProgress", () => {
	const running = {
		status: "running",
		progress: { percent: 42, currentSection: "keys" },
		message: "Importing keys",
	}

	it("reports the current progress", () => {
		expect(importJobProgress(running)).toEqual({
			status: "running",
			progress: 42,
			section: "keys",
			message: "Importing keys",
		})
	})

	it("carries no error key while the job runs", () => {
		expect(importJobProgress(running)).not.toHaveProperty("error")
	})

	it("carries the error on a failed job", () => {
		expect(importJobProgress({ ...running, status: "error", error: "disk full" })).toMatchObject({
			error: "disk full",
		})
	})

	it("supplies a message for a failed job that gave none", () => {
		expect(importJobProgress({ status: "error" }).error).toBe("Failed to import database")
	})

	it("defaults a missing progress to zero, not to NaN", () => {
		expect(importJobProgress({ status: "queued" })).toMatchObject({
			progress: 0,
			section: null,
			message: null,
		})
	})
})
