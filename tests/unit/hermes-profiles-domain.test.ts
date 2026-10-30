import { describe, expect, test } from "bun:test"
import {
	commandFor,
	displayNameFrom,
	IDENTITY_FILES,
	isValidHermesProfileName,
	PROFILE_NAME_RE,
	resolveHermesHome,
} from "../../apps/api/src/domain/hermes-profiles.ts"

/**
 * The name and the path are the security boundary of the Hermes flow: a profile name becomes a
 * directory *and* a shell alias, so this is the file that has to be right. Everything else
 * decides what to write; this decides where.
 *
 * `tests/unit/hermes-profiles.test.ts` covers the same ground against a real temporary
 * filesystem, for `apps/web`'s route-local helper. This file is the domain's own contract, and
 * it runs without touching disk — which is the reason the rules were moved out of that helper.
 */

const HOME = "/home/operator"

describe("profile names", () => {
	test("plain names, dashes and underscores are accepted", () => {
		for (const name of ["work", "my-profile", "my_profile", "a", "A9"]) {
			expect(isValidHermesProfileName(name)).toBe(true)
		}
	})

	test("'default' is refused as a name, because it is the root", () => {
		expect(isValidHermesProfileName("default")).toBe(false)
		expect(isValidHermesProfileName("DEFAULT")).toBe(false)
	})

	test("anything a shell or a path would interpret is refused", () => {
		for (const name of ["../escape", "a/b", "a b", "a;rm", "a$b", "a`b`", "a\nb", "-leading"]) {
			expect(isValidHermesProfileName(name)).toBe(false)
		}
	})

	test("an empty name, a non-string, and a name over 64 chars are refused", () => {
		expect(isValidHermesProfileName("")).toBe(false)
		expect(isValidHermesProfileName(null)).toBe(false)
		expect(isValidHermesProfileName(42)).toBe(false)
		expect(isValidHermesProfileName("a".repeat(65))).toBe(false)
		expect(isValidHermesProfileName("a".repeat(64))).toBe(true)
	})

	test("the regex and the guard agree, so one cannot drift from the other", () => {
		for (const name of ["work", "a/b", "default", ""]) {
			const byRegex = PROFILE_NAME_RE.test(name) && name.toLowerCase() !== "default"
			expect(isValidHermesProfileName(name)).toBe(byRegex)
		}
	})
})

describe("resolving a profile to a home", () => {
	test("empty, null and 'default' all mean the install root", () => {
		for (const profile of [undefined, null, "", "default", "  "]) {
			const home = resolveHermesHome(profile, undefined as never, HOME)
			expect(home.isDefault).toBe(true)
			expect(home.name).toBe("default")
			expect(home.dir).toBe("/home/operator/.hermes")
			expect(home.configPath).toBe("/home/operator/.hermes/config.yaml")
			expect(home.envPath).toBe("/home/operator/.hermes/.env")
		}
	})

	test("a named profile lives under profiles/", () => {
		const home = resolveHermesHome("work", undefined as never, HOME)
		expect(home.isDefault).toBe(false)
		expect(home.name).toBe("work")
		expect(home.dir).toBe("/home/operator/.hermes/profiles/work")
		expect(home.configPath).toBe("/home/operator/.hermes/profiles/work/config.yaml")
	})

	test("the name is trimmed before it is used", () => {
		expect(resolveHermesHome("  work  ", undefined as never, HOME).name).toBe("work")
	})

	test("an invalid name throws rather than returning a path", () => {
		expect(() => resolveHermesHome("../escape", undefined as never, HOME)).toThrow()
		expect(() => resolveHermesHome("a/b", undefined as never, HOME)).toThrow()
	})

	test("a root override is honoured, which is what makes the resolver usable off this machine", () => {
		expect(resolveHermesHome("work", "/tmp/hermes-root", HOME).dir).toBe(
			"/tmp/hermes-root/profiles/work",
		)
	})

	test("the resolved directory always stays inside profiles/", () => {
		const home = resolveHermesHome("work", undefined as never, HOME)
		expect(home.dir.startsWith("/home/operator/.hermes/profiles/")).toBe(true)
	})
})

describe("what the screen shows for a profile", () => {
	test("the default profile is run as plain `hermes`", () => {
		expect(commandFor("default", true)).toBe("hermes")
	})

	test("a named profile needs -p", () => {
		expect(commandFor("work", false)).toBe("hermes -p work")
	})

	test("display_name is read with or without quotes, and absent means null", () => {
		expect(displayNameFrom('display_name: "Work Bot"\n')).toBe("Work Bot")
		expect(displayNameFrom("display_name: Work Bot\n")).toBe("Work Bot")
		expect(displayNameFrom("display_name: 'Work Bot'\n")).toBe("Work Bot")
		expect(displayNameFrom("model: x\n")).toBeNull()
	})
})

describe("identity files", () => {
	test("every file Hermes writes counts, so a real profile is never invisible", () => {
		expect([...IDENTITY_FILES]).toEqual([
			"config.yaml",
			".env",
			"SOUL.md",
			"profile.yaml",
			"auth.json",
			"state.db",
		])
	})
})
