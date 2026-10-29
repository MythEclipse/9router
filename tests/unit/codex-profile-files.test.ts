import { describe, expect, it } from "vitest"
import {
	codexProfile,
	codexProfileFile,
	codexProfileToml,
	isValidCodexModel,
	isValidProfileName,
	normaliseProfileName,
	profileNameFromFile,
	readProfileModel,
} from "../../apps/api/src/domain/codex-profiles.ts"

/**
 * The profile name becomes a file name and the model becomes a quoted TOML value, so these are
 * the two places where a careless string turns into a file this screen did not mean to write.
 *
 * Distinct from `codex-profiles.test.ts`, which covers the dashboard's own helper for deriving a
 * profile name from a model id. This file covers what the route and the filesystem share.
 */

describe("isValidProfileName", () => {
	it("accepts the names that are also valid CLI arguments", () => {
		expect(isValidProfileName("work")).toBe(true)
		expect(isValidProfileName("work-2")).toBe(true)
		expect(isValidProfileName("a_b")).toBe(true)
	})

	it("refuses path separators and dots", () => {
		// `../x` would write outside ~/.codex, and a dot cannot be typed as `codex -p <name>`.
		expect(isValidProfileName("../x")).toBe(false)
		expect(isValidProfileName("a/b")).toBe(false)
		expect(isValidProfileName("a.b")).toBe(false)
		expect(isValidProfileName("a b")).toBe(false)
	})

	it("refuses the base config name in any casing", () => {
		// `config.config.toml` reads like the base file and would be edited by mistake.
		expect(isValidProfileName("config")).toBe(false)
		expect(isValidProfileName("CONFIG")).toBe(false)
		expect(isValidProfileName("Config")).toBe(false)
	})

	it("refuses an over-long name", () => {
		expect(isValidProfileName("a".repeat(64))).toBe(true)
		expect(isValidProfileName("a".repeat(65))).toBe(false)
	})

	it("refuses non-strings", () => {
		expect(isValidProfileName(undefined)).toBe(false)
		expect(isValidProfileName(42)).toBe(false)
	})
})

describe("isValidCodexModel", () => {
	it("accepts a plain model id", () => {
		expect(isValidCodexModel("gpt-5.1-codex")).toBe(true)
	})

	it("refuses a quote or a newline, which would end the TOML string", () => {
		// `model = "x"` followed by a new key must not be writable.
		expect(isValidCodexModel('x"')).toBe(false)
		expect(isValidCodexModel("x\ny")).toBe(false)
		expect(isValidCodexModel("x\r\ny")).toBe(false)
	})

	it("refuses blank and over-long values", () => {
		expect(isValidCodexModel("   ")).toBe(false)
		expect(isValidCodexModel("a".repeat(257))).toBe(false)
	})
})

describe("normaliseProfileName", () => {
	it("trims and lowercases, because a file name should not depend on how it was typed", () => {
		expect(normaliseProfileName("  Work  ")).toBe("work")
		expect(normaliseProfileName(undefined)).toBe("")
	})
})

describe("profileNameFromFile", () => {
	it("names a profile from its file", () => {
		expect(profileNameFromFile("work.config.toml")).toBe("work")
	})

	it("excludes the base config, which shares the suffix", () => {
		// Without this exclusion the screen lists a profile called "config".
		expect(profileNameFromFile("config.toml")).toBe(null)
	})

	it("ignores files that are not profiles", () => {
		expect(profileNameFromFile("auth.json")).toBe(null)
		expect(profileNameFromFile(".config.toml")).toBe(null)
		expect(profileNameFromFile("work.toml")).toBe(null)
	})
})

describe("codexProfileToml", () => {
	it("writes the header, the model and this install's provider", () => {
		expect(codexProfileToml("work", "gpt-5")).toBe(
			'# codex -p work\nmodel = "gpt-5"\nmodel_provider = "9router"\n',
		)
	})

	it("round-trips through readProfileModel", () => {
		expect(readProfileModel(codexProfileToml("work", "gpt-5"))).toBe("gpt-5")
	})
})

describe("readProfileModel", () => {
	it("reads a single-quoted value too, since these files are hand-edited", () => {
		expect(readProfileModel("model = 'gpt-5'\n")).toBe("gpt-5")
	})

	it("answers empty for a profile with no model", () => {
		expect(readProfileModel("# nothing here\n")).toBe("")
		expect(readProfileModel('model_provider = "9router"\n')).toBe("")
	})
})

describe("codexProfile", () => {
	it("reports the command the operator should run", () => {
		expect(codexProfile("work", "gpt-5")).toEqual({
			name: "work",
			model: "gpt-5",
			command: "codex -p work",
		})
	})

	it("keeps the file name in step with the name", () => {
		expect(codexProfileFile("work")).toBe("work.config.toml")
	})
})
