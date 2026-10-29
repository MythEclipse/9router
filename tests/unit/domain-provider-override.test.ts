import { describe, expect, it } from "vitest"
import {
	MAX_HEADER_VALUE_LENGTH,
	MAX_HEADERS,
	readOverride,
	withOverride,
} from "../../apps/api/src/domain/provider-override.ts"

describe("readOverride", () => {
	it("accepts a header map", () => {
		expect(readOverride({ headers: { "x-route": "eu" } })).toEqual({
			kind: "ok",
			override: { headers: { "x-route": "eu" } },
		})
	})

	it("treats a missing headers field as a clear", () => {
		expect(readOverride({})).toEqual({ kind: "ok", override: null })
		expect(readOverride({ headers: null })).toEqual({ kind: "ok", override: null })
	})

	it("treats all-blank headers as a clear rather than an empty object", () => {
		expect(readOverride({ headers: { "x-a": "", "x-b": null } })).toEqual({
			kind: "ok",
			override: null,
		})
	})

	it("drops blank values but keeps the rest", () => {
		expect(readOverride({ headers: { "x-a": "", "x-b": "1" } })).toEqual({
			kind: "ok",
			override: { headers: { "x-b": "1" } },
		})
	})

	it("refuses a non-object headers field", () => {
		for (const bad of ["nope", 42, true, ["x"]]) {
			expect(readOverride({ headers: bad })).toEqual({
				kind: "invalid",
				message: "headers must be an object",
			})
		}
	})

	it(`refuses more than ${MAX_HEADERS} headers`, () => {
		const headers = Object.fromEntries(
			Array.from({ length: MAX_HEADERS + 1 }, (_, i) => [`x-${i}`, "v"]),
		)
		expect(readOverride({ headers })).toEqual({
			kind: "invalid",
			message: `Too many headers (max ${MAX_HEADERS})`,
		})
	})

	it(`accepts exactly ${MAX_HEADERS} headers`, () => {
		const headers = Object.fromEntries(Array.from({ length: MAX_HEADERS }, (_, i) => [`x-${i}`, "v"]))
		expect(readOverride({ headers }).kind).toBe("ok")
	})

	it.each(["x route", "x:route", "x_route", "x-route\r", "ünicode"])(
		"refuses the non-token name %j",
		(name) => {
			expect(readOverride({ headers: { [name]: "v" } })).toEqual({
				kind: "invalid",
				message: `Invalid header name: ${name}`,
			})
		},
	)

	it("refuses a value containing CR or LF, which is header injection", () => {
		for (const value of ["a\rb", "a\nb", "a\r\nb"]) {
			expect(readOverride({ headers: { "x-a": value } })).toEqual({
				kind: "invalid",
				message: "Invalid value for header x-a",
			})
		}
	})

	it("refuses a non-string value", () => {
		expect(readOverride({ headers: { "x-a": 1 } })).toEqual({
			kind: "invalid",
			message: "Invalid value for header x-a",
		})
	})

	it(`refuses a value longer than ${MAX_HEADER_VALUE_LENGTH}`, () => {
		const long = "a".repeat(MAX_HEADER_VALUE_LENGTH + 1)
		expect(readOverride({ headers: { "x-a": long } })).toEqual({
			kind: "invalid",
			message: `Header x-a value too long (max ${MAX_HEADER_VALUE_LENGTH})`,
		})
	})

	it(`accepts a value of exactly ${MAX_HEADER_VALUE_LENGTH}`, () => {
		const exact = "a".repeat(MAX_HEADER_VALUE_LENGTH)
		expect(readOverride({ headers: { "x-a": exact } }).kind).toBe("ok")
	})

	it.each([
		"host",
		"content-length",
		"content-type",
		"connection",
		"transfer-encoding",
		"authorization",
		"cookie",
	])("refuses the blocked header %j", (name) => {
		expect(readOverride({ headers: { [name]: "v" } })).toEqual({
			kind: "invalid",
			message: `Header ${name} cannot be overridden`,
		})
	})

	it("blocks case-insensitively", () => {
		for (const name of ["Host", "AUTHORIZATION", "Content-Type"]) {
			expect(readOverride({ headers: { [name]: "v" } }).kind).toBe("invalid")
		}
	})

	it("allows a header that merely resembles a blocked one", () => {
		expect(readOverride({ headers: { "x-authorization": "v" } }).kind).toBe("ok")
	})
})

describe("withOverride", () => {
	const current = { gemini: { headers: { "x-a": "1" } }, openai: { headers: { "x-b": "2" } } }

	it("sets one provider without touching the others", () => {
		const next = withOverride(current, "gemini", { headers: { "x-c": "3" } })
		expect(next).toEqual({
			gemini: { headers: { "x-c": "3" } },
			openai: { headers: { "x-b": "2" } },
		})
	})

	it("removes the key rather than storing an empty override", () => {
		const next = withOverride(current, "gemini", null)
		expect(next).toEqual({ openai: { headers: { "x-b": "2" } } })
		expect("gemini" in next).toBe(false)
	})

	it("does not mutate the input", () => {
		withOverride(current, "gemini", null)
		expect(current).toHaveProperty("gemini")
	})

	it("adds a provider that was not there", () => {
		expect(withOverride({}, "kilo", { headers: { "x-k": "1" } })).toEqual({
			kilo: { headers: { "x-k": "1" } },
		})
	})
})
