import { describe, expect, it } from "vitest"
import {
	jcodeHasThisInstall,
	jcodeProviderBlock,
	removeJcodeProvider,
	withJcodeProvider,
} from "../../apps/api/src/domain/jcode-config.ts"

/**
 * jcode's TOML is spliced as text, so two properties matter: the entry is replaced rather than
 * appended on the second save, and a neighbouring table is never eaten by the splice.
 */

const EXISTING = [
	"[providers.other]",
	'type = "anthropic"',
	'base_url = "https://api.example.com"',
	'note = "keep me exactly as written"',
	"",
	"[ui]",
	'theme = "dark"',
].join("\n")

describe("jcodeProviderBlock", () => {
	it("points the entry at the env file rather than inlining the key", () => {
		const block = jcodeProviderBlock({ baseUrl: "http://x/v1", model: "gpt-5" })
		// Inlining a key would put a credential in a file the operator commits by habit.
		expect(block).toContain('api_key_env = "JCODE_9ROUTER_API_KEY"')
		expect(block).toContain('env_file = "provider-9router.env"')
		expect(block).toContain('base_url = "http://x/v1"')
		expect(block).toContain('default_model = "gpt-5"')
		expect(block).not.toMatch(/api_key\s*=\s*"/)
	})
})

describe("withJcodeProvider", () => {
	it("writes the entry into an empty config", () => {
		expect(withJcodeProvider("", "http://x/v1", "m")).toBe(
			`${jcodeProviderBlock({ baseUrl: "http://x/v1", model: "m" })}\n`,
		)
	})

	it("leaves a neighbouring table byte-identical", () => {
		const written = withJcodeProvider(EXISTING, "http://x/v1", "m")
		expect(written).toContain(EXISTING)
		// The comment-bearing line is the one a re-serialising writer would reformat or drop.
		expect(written).toContain('note = "keep me exactly as written"')
		expect(written).toContain("[providers.9router]")
	})

	it("is idempotent: saving twice leaves one entry", () => {
		const once = withJcodeProvider(EXISTING, "http://x/v1", "m")
		const twice = withJcodeProvider(once, "http://y/v1", "m2")
		expect(twice.match(/^\[providers\.9router\]$/gm)).toHaveLength(1)
		expect(twice).toContain("http://y/v1")
		expect(twice).not.toContain("http://x/v1")
	})

	it("does not touch a table that follows ours", () => {
		const written = withJcodeProvider(EXISTING, "http://x/v1", "m")
		const reRemoved = removeJcodeProvider(written)
		expect(reRemoved).toContain("[ui]")
		expect(reRemoved).toContain('theme = "dark"')
		expect(reRemoved).not.toContain("[providers.9router]")
	})
})

describe("jcodeHasThisInstall", () => {
	it("recognises our entry or this install's host", () => {
		expect(jcodeHasThisInstall("")).toBe(false)
		expect(jcodeHasThisInstall("[providers.9router]")).toBe(true)
		expect(jcodeHasThisInstall('base_url = "http://localhost:20128/v1"')).toBe(true)
		expect(jcodeHasThisInstall('base_url = "https://api.other.com"')).toBe(false)
	})
})
