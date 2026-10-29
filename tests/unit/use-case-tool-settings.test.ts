import { describe, expect, it, vi } from "vitest"
import {
	readToolSettingsStatus,
	resetToolSettings,
	writeToolSettings,
} from "../../apps/api/src/application/cli-tools/manage-tool-settings.ts"
import {
	mergeModelEntries,
	NOTHING_TO_RESET,
	normaliseBaseUrl,
	pointsAtThisInstall,
	readModelEntries,
	readToolSettings,
	removeInstallEntry,
	settingsFileText,
	THIS_INSTALL_HOSTS,
} from "../../apps/api/src/domain/cli-tool-settings.ts"

describe("normaliseBaseUrl", () => {
	it("appends /v1, which every OpenAI-compatible tool requires", () => {
		expect(normaliseBaseUrl("http://localhost:20128")).toBe("http://localhost:20128/v1")
	})

	it("leaves a URL that already names /v1 alone", () => {
		expect(normaliseBaseUrl("http://localhost:20128/v1")).toBe("http://localhost:20128/v1")
	})

	it("answers the spelling Cline needs, which is the URL without the suffix", () => {
		// Cline appends the full path itself; giving it /v1 produces /v1/chat/completions.
		expect(normaliseBaseUrl("http://localhost:20128/v1", "without-v1")).toBe("http://localhost:20128")
		expect(normaliseBaseUrl("http://localhost:20128", "without-v1")).toBe("http://localhost:20128")
	})

	it("does not double a suffix the operator already typed", () => {
		expect(normaliseBaseUrl("http://localhost:20128/v1", "with-v1")).toBe("http://localhost:20128/v1")
	})

	it("drops trailing slashes rather than producing /v1/", () => {
		expect(normaliseBaseUrl("http://localhost:20128//")).toBe("http://localhost:20128/v1")
		expect(normaliseBaseUrl("http://localhost:20128/v1/")).toBe("http://localhost:20128/v1")
	})

	it("trims the whitespace a paste carries", () => {
		expect(normaliseBaseUrl("  http://localhost:20128  ")).toBe("http://localhost:20128/v1")
	})
})

describe("pointsAtThisInstall", () => {
	it("recognises the default local address", () => {
		expect(pointsAtThisInstall("http://localhost:20128/v1", THIS_INSTALL_HOSTS)).toBe(true)
		expect(pointsAtThisInstall("http://127.0.0.1:20128/v1", THIS_INSTALL_HOSTS)).toBe(true)
	})

	it("recognises a public host that names the product", () => {
		expect(pointsAtThisInstall("https://9router.example.com/v1", THIS_INSTALL_HOSTS)).toBe(true)
	})

	it("ignores case, because a host is not case-sensitive", () => {
		expect(pointsAtThisInstall("HTTP://LOCALHOST:20128/v1", THIS_INSTALL_HOSTS)).toBe(true)
	})

	it("does not claim a third-party endpoint", () => {
		expect(pointsAtThisInstall("https://api.openai.com/v1", THIS_INSTALL_HOSTS)).toBe(false)
	})

	it("answers false for a value that is not a string", () => {
		expect(pointsAtThisInstall(undefined, THIS_INSTALL_HOSTS)).toBe(false)
		expect(pointsAtThisInstall(null, THIS_INSTALL_HOSTS)).toBe(false)
	})
})

describe("readToolSettings", () => {
	it("reads the three required fields and leaves the URL as typed", () => {
		// Which spelling of /v1 a tool wants is that tool's business, so the reader must not
		// pick one: applying a default here would override the single tool that wants the
		// other spelling.
		const read = readToolSettings({
			baseUrl: "http://localhost:20128",
			apiKey: "sk-1",
			model: "gpt-4",
		})
		expect(read.input).toEqual({
			baseUrl: "http://localhost:20128",
			apiKey: "sk-1",
			model: "gpt-4",
		})
	})

	it("names the fields a half-filled form is missing", () => {
		// A config missing a field is one the tool cannot use, and it fails inside the tool,
		// where the operator cannot see that the screen accepted half a form. Naming the field
		// is what tells them which box to fill.
		expect(readToolSettings({ baseUrl: "http://x", apiKey: "k" })).toEqual({
			ok: false,
			error: "model is required",
		})
	})

	it("accepts a form that only carries what the tool requires", () => {
		// Pi resolves the key from the dashboard and has a documented default model, so its
		// card is a one-field form. Demanding all three turns that into a 400.
		expect(readToolSettings({ baseUrl: "http://x" }, ["baseUrl"])).toMatchObject({ ok: true })
	})

	it("treats a whitespace-only field as missing", () => {
		expect(readToolSettings({ baseUrl: "  ", apiKey: "k", model: "m" }).ok).toBe(false)
	})

	it("refuses a body that is not an object", () => {
		expect(readToolSettings(null).ok).toBe(false)
	})
})

describe("removeInstallEntry", () => {
	it("removes both spellings and reports that something changed", () => {
		const config: Record<string, unknown> = { "openai-compatible": {}, "9router": {}, other: 1 }
		expect(removeInstallEntry(config, ["openai-compatible", "9router"])).toBe(true)
		expect(config).toEqual({ other: 1 })
	})

	it("reports nothing changed when the file had no entry", () => {
		// The caller distinguishes "removed" from "was not there" to pick its message.
		const config: Record<string, unknown> = { other: 1 }
		expect(removeInstallEntry(config, ["openai-compatible"])).toBe(false)
	})
})

describe("settingsFileText", () => {
	it("pretty-prints with a trailing newline, so the file is diff-clean", () => {
		expect(settingsFileText({ a: 1 })).toBe('{\n  "a": 1\n}\n')
	})
})

/** A tool whose config is an in-memory object, recording the writes. */
function tool(overrides: Record<string, unknown> = {}) {
	const written: string[] = []
	let config: Record<string, unknown> | null = { "openai-compatible": { baseUrl: "x" } }
	const deps = {
		written,
		getConfig: () => config,
		isInstalled: vi.fn(async () => true),
		config: {
			path: "/home/u/.tool/auth.json",
			read: vi.fn(async () => config),
			readForWrite: vi.fn(async () => config ?? {}),
			write: vi.fn(async (text: string) => {
				written.push(text)
				config = JSON.parse(text)
			}),
			baseUrlSuffix: "with-v1" as const,
			installKeys: ["openai-compatible", "9router"],
			storedBaseUrl: (c: Record<string, unknown> | null) => {
				const entry = c?.["openai-compatible"] as Record<string, unknown> | undefined
				return typeof entry?.baseUrl === "string" ? entry.baseUrl : null
			},
			apply: (
				c: Record<string, unknown>,
				input: { baseUrl: string; apiKey: string; model: string },
			) => ({
				...c,
				"openai-compatible": {
					baseUrl: input.baseUrl,
					apiKey: input.apiKey,
					model: input.model,
				},
			}),
		},
		notInstalledMessage: "not installed",
		appliedMessage: "applied",
		resetMessage: "reset",
	}
	// Overrides may patch the config port itself; fold them into the port so the use-case,
	// which reads through `deps.config`, sees the patched behaviour.
	return {
		...deps,
		...overrides,
		config: overrides.config ? { ...deps.config, ...(overrides.config as object) } : deps.config,
	}
}

describe("readToolSettingsStatus", () => {
	it("answers installed with whether it already points here", async () => {
		const deps = tool()
		deps.config.read.mockResolvedValueOnce({
			"openai-compatible": { baseUrl: "http://localhost:20128/v1" },
		})
		const answer = await readToolSettingsStatus(deps as never)

		expect(answer.status).toBe(200)
		expect(answer.body.installed).toBe(true)
		expect(answer.body.has9Router).toBe(true)
	})

	it("answers 200 with installed:false rather than 404 for a missing tool", async () => {
		// A 404 reads as "this endpoint does not exist" and the screen would not render the
		// install panel.
		const deps = tool({ isInstalled: async () => false, installUrl: "https://tool.dev" })
		const answer = await readToolSettingsStatus(deps as never)

		expect(answer.status).toBe(200)
		expect(answer.body).toMatchObject({ installed: false, installUrl: "https://tool.dev" })
	})
})

describe("writeToolSettings", () => {
	it("writes the normalised config in the tool's own shape", async () => {
		const deps = tool()
		const answer = await writeToolSettings(
			{ baseUrl: "http://localhost:20128", apiKey: "k", model: "m" },
			deps as never,
		)

		expect(answer.ok).toBe(true)
		expect(deps.getConfig()).toMatchObject({
			"openai-compatible": {
				baseUrl: "http://localhost:20128/v1",
				apiKey: "k",
				model: "m",
			},
		})
	})

	it("writes the spelling the tool declares, not a house default", async () => {
		// The bug this guards: one normalisation shared by all tools writes /v1/v1 for Cline.
		const deps = tool({ config: { baseUrlSuffix: "without-v1" } })
		await writeToolSettings(
			{ baseUrl: "http://localhost:20128/v1", apiKey: "k", model: "m" },
			deps as never,
		)

		expect(deps.getConfig()).toMatchObject({
			"openai-compatible": { baseUrl: "http://localhost:20128" },
		})
	})

	it("keeps the tool's other provider entries", async () => {
		const deps = tool()
		deps.config.readForWrite.mockResolvedValueOnce({ anthropic: { key: "a" } })
		await writeToolSettings({ baseUrl: "http://x", apiKey: "k", model: "m" }, deps as never)

		expect(deps.getConfig()).toMatchObject({ anthropic: { key: "a" } })
	})

	it("refuses before writing anything when the form is incomplete", async () => {
		const deps = tool()
		const answer = await writeToolSettings({ baseUrl: "http://x" }, deps as never)

		expect(answer.status).toBe(400)
		expect(deps.config.write).not.toHaveBeenCalled()
	})

	it("writes even when the tool looks uninstalled, because that is what it fixes", async () => {
		// A tool that has never run has no config file, so an install check here refuses
		// exactly the state this screen exists to correct. GET reports it instead.
		const deps = tool({ isInstalled: async () => false })
		const answer = await writeToolSettings(
			{ baseUrl: "http://x", apiKey: "k", model: "m" },
			deps as never,
		)

		expect(answer.status).toBe(200)
		expect(deps.config.write).toHaveBeenCalled()
	})

	it("refuses to overwrite a config it cannot parse, rather than dropping its settings", async () => {
		// The bug this guards: a `read` that answers null for a corrupt file makes the write
		// start from {} and silently discard every other setting the operator had.
		const deps = tool()
		deps.config.readForWrite.mockRejectedValueOnce(
			new Error("Existing config could not be read (Unexpected token). Refusing to overwrite it"),
		)
		const answer = await writeToolSettings(
			{ baseUrl: "http://x", apiKey: "k", model: "m" },
			deps as never,
		)

		expect(answer).toMatchObject({ ok: false, status: 500 })
		expect(String(answer.body.error)).toContain("Refusing to overwrite")
		expect(deps.config.write).not.toHaveBeenCalled()
	})

	it("still succeeds when a side write fails, because the tool already works", async () => {
		// The side write is an editor's settings file; refusing the whole request would tell
		// the operator they configured nothing while the tool is configured.
		const sideWrite = vi.fn(async () => {
			throw new Error("EACCES")
		})
		const deps = tool({ sideWrites: [sideWrite] })
		const answer = await writeToolSettings(
			{ baseUrl: "http://x", apiKey: "k", model: "m" },
			deps as never,
		)

		expect(answer.ok).toBe(true)
		expect(sideWrite).toHaveBeenCalled()
		expect(deps.config.write).toHaveBeenCalled()
	})
})

describe("resetToolSettings", () => {
	it("removes the install entry and keeps everything else", async () => {
		const deps = tool()
		deps.config.read.mockResolvedValueOnce({ "openai-compatible": {}, anthropic: { k: 1 } })
		const answer = await resetToolSettings(deps as never)

		expect(answer.body).toEqual({ success: true, message: "reset" })
		expect(deps.getConfig()).toEqual({ anthropic: { k: 1 } })
	})

	it("succeeds with a different message when there was no file", async () => {
		// The operator asked the tool to stop pointing here, and it already does not.
		const deps = tool()
		deps.config.read.mockResolvedValueOnce(null)
		const answer = await resetToolSettings(deps as never)

		expect(answer.body).toEqual({ success: true, message: NOTHING_TO_RESET })
		expect(deps.config.write).not.toHaveBeenCalled()
	})

	it("answers 500 with the reason when the file cannot be written", async () => {
		const deps = tool()
		deps.config.write.mockRejectedValueOnce(new Error("EROFS: read-only file system"))
		const answer = await resetToolSettings(deps as never)

		expect(answer).toMatchObject({ ok: false, status: 500 })
		expect(String(answer.body.error)).toContain("read-only")
	})
})

describe("tool model lists", () => {
	it("reads both shapes tools write, so neither tool's models disappear", () => {
		expect(readModelEntries(["gpt-4"])).toEqual([{ id: "gpt-4" }])
		expect(readModelEntries([{ id: "gpt-4", name: "GPT-4" }])).toEqual([
			{ id: "gpt-4", name: "GPT-4" },
		])
		expect(readModelEntries(undefined)).toEqual([])
	})

	it("keeps a hand-tuned limit when the form only rotates the key", () => {
		// Rotating a key is not a reason to lose contextWindow an operator set by hand.
		const merged = mergeModelEntries(
			[{ id: "gpt-4", contextWindow: 900000, maxTokens: 64000 }],
			["gpt-4"],
		)
		expect(merged).toEqual([{ id: "gpt-4", contextWindow: 900000, maxTokens: 64000, name: "gpt-4" }])
	})

	it("keeps the models already configured when the form sends no list", () => {
		const merged = mergeModelEntries([{ id: "a" }, { id: "b" }], undefined)
		expect(merged.map((m) => m.id)).toEqual(["a", "b"])
	})

	it("does not invent a name from the id when one is already set", () => {
		const merged = mergeModelEntries([{ id: "m", name: "My Model" }], [{ id: "m" }])
		expect(merged[0]?.name).toBe("My Model")
	})
})

describe("settings file format", () => {
	it("writes JSON by default, which is what most tools parse", () => {
		expect(settingsFileText({ a: 1 })).toBe('{\n  "a": 1\n}\n')
	})

	it("writes TOML when the tool parses TOML", () => {
		// The bug this guards: TOML written into a file the tool parses as JSON reads back as
		// garbage, so one save through this screen breaks a working tool.
		const text = settingsFileText(
			{ openai: { model: "m" } },
			"toml",
			(config) => `[openai]\nmodel = "${(config.openai as { model: string }).model}"\n`,
		)
		expect(text).toBe('[openai]\nmodel = "m"\n')
	})

	it("refuses to guess a TOML serialiser", () => {
		expect(() => settingsFileText({ a: 1 }, "toml")).toThrow(/TOML serialiser/)
	})
})
