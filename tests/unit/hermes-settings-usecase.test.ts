import { describe, expect, test } from "bun:test"
import type {
	HermesFilesPort,
	HermesHomeView,
	HermesProfileSummary,
} from "../../apps/api/src/application/hermes/manage-hermes-settings.ts"
import {
	readHermesSettings,
	resetHermesSettings,
	writeHermesSettings,
} from "../../apps/api/src/application/hermes/manage-hermes-settings.ts"
import { resolveHermesHome } from "../../apps/api/src/domain/hermes-profiles.ts"

/**
 * The policies worth proving are the three the route held inline and nothing could test:
 *
 * - only blocks this install wrote are removed, so a provider choice survives a reset;
 * - only the `OPENAI_API_KEY` line is touched in `.env`, because that file also holds bot tokens;
 * - a bulk apply reports a foreign provider instead of rewriting it.
 *
 * The YAML block handling itself is covered by `hermes-yaml.test.ts`; this file is about the
 * decisions around it.
 */

const HOME = "/home/operator"
const BASE = "http://127.0.0.1:20128/v1"

const ninesRouterModel = `model:\n  default: "anthropic/claude-sonnet-4-6"\n  provider: "custom"\n  base_url: "${BASE}"\n  api_key: \${OPENAI_API_KEY}\n`
const foreignModel = `model:\n  default: "gpt-5"\n  provider: "openai"\n  base_url: "https://api.openai.com/v1"\n`

interface Fake extends HermesFilesPort {
	readonly configs: Map<string, string>
	readonly envs: Map<string, string>
	readonly writes: string[]
}

const fake = (init: {
	configs?: Record<string, string>
	envs?: Record<string, string>
	installed?: boolean
	profiles?: HermesProfileSummary[]
	missingDirs?: string[]
}): Fake => {
	const configs = new Map(Object.entries(init.configs ?? {}))
	const envs = new Map(Object.entries(init.envs ?? {}))
	const writes: string[] = []
	const missing = new Set(init.missingDirs ?? [])

	return {
		configs,
		envs,
		writes,
		resolve: (profile) => {
			try {
				return { home: resolveHermesHome(profile, undefined as never, HOME) as HermesHomeView }
			} catch (error) {
				return { error: error instanceof Error ? error.message : "Invalid profile" }
			}
		},
		dirExists: async (dir) => !missing.has(dir),
		readConfig: async (home) => configs.get(home.configPath) ?? "",
		readEnv: async (home) => envs.get(home.envPath) ?? "",
		writeConfig: async (home, yaml) => {
			writes.push(home.configPath)
			configs.set(home.configPath, yaml)
		},
		writeEnvKey: async (home, apiKey) => {
			if (!apiKey) return
			writes.push(home.envPath)
			envs.set(home.envPath, `OPENAI_API_KEY=${apiKey}\n`)
		},
		configMissing: async (home) => !configs.has(home.configPath),
		isInstalled: async () => init.installed ?? true,
		listProfiles: async (): Promise<HermesProfileSummary[]> =>
			init.profiles ?? [
				{
					name: "default",
					dir: `${HOME}/.hermes`,
					isDefault: true,
					displayName: null,
					command: "hermes",
					alias: null,
					model: null,
					baseUrl: null,
					has9Router: false,
				},
			],
	}
}

describe("reading hermes settings", () => {
	test("an uninstalled Hermes is 200 with installed:false, not a 404", async () => {
		const answer = await readHermesSettings(null, fake({ installed: false }))
		expect(answer.status).toBe(200)
		expect(answer.body.installed).toBe(false)
		expect(answer.body.settings).toBeNull()
	})

	test("an invalid profile name is a 400 with the domain's message", async () => {
		const answer = await readHermesSettings("a/b", fake({}))
		expect(answer.status).toBe(400)
		expect(String(answer.body.error)).toContain("Invalid Hermes profile name")
	})

	test("an unknown named profile is a 404, because it is a different fix", async () => {
		const answer = await readHermesSettings(
			"ghost",
			fake({ missingDirs: [`${HOME}/.hermes/profiles/ghost`] }),
		)
		expect(answer.status).toBe(404)
		expect(answer.body.error).toBe('Hermes profile "ghost" not found')
	})

	test("the default home is never 404, since it is created on demand", async () => {
		const answer = await readHermesSettings(null, fake({ missingDirs: [`${HOME}/.hermes`] }))
		expect(answer.status).toBe(200)
		expect(answer.body.installed).toBe(true)
	})

	test("has9Router is true when any of the three block families points here", async () => {
		const answer = await readHermesSettings(
			null,
			fake({ configs: { [`${HOME}/.hermes/config.yaml`]: ninesRouterModel } }),
		)
		expect(answer.body.has9Router).toBe(true)
	})

	test("has9Router is false for a profile pointing at another provider", async () => {
		const answer = await readHermesSettings(
			null,
			fake({ configs: { [`${HOME}/.hermes/config.yaml`]: foreignModel } }),
		)
		expect(answer.body.has9Router).toBe(false)
	})

	test("has9RouterStt is reported separately from has9Router", async () => {
		const answer = await readHermesSettings(null, fake({}))
		expect(answer.body.has9RouterStt).toBe(false)
	})
})

describe("writing one profile", () => {
	test("baseUrl alone is a 400: there is no model to write", async () => {
		const answer = await writeHermesSettings({ baseUrl: BASE }, fake({}))
		expect(answer.status).toBe(400)
		expect(answer.body.error).toBe("baseUrl and model are required")
	})

	test("/v1 is appended only when missing", async () => {
		const withoutV1 = fake({})
		await writeHermesSettings({ baseUrl: "http://x:1", model: "m" }, withoutV1)
		expect(String(withoutV1.configs.get(`${HOME}/.hermes/config.yaml`))).toContain("http://x:1/v1")

		const withV1 = fake({})
		await writeHermesSettings({ baseUrl: "http://x:1/v1", model: "m" }, withV1)
		expect(String(withV1.configs.get(`${HOME}/.hermes/config.yaml`))).not.toContain("/v1/v1")
	})

	test("a bare `model` is treated as the default role, which is what the legacy CLI sends", async () => {
		const port = fake({})
		const answer = await writeHermesSettings({ baseUrl: BASE, model: "m" }, port)
		expect(answer.status).toBe(200)
		expect(String(port.configs.get(`${HOME}/.hermes/config.yaml`))).toContain('default: "m"')
	})

	test("selections win over a bare model, so an auxiliary role is not silently dropped", async () => {
		const port = fake({})
		await writeHermesSettings(
			{
				baseUrl: BASE,
				model: "ignored",
				selections: [
					{ role: "default", model: "main" },
					{ role: "coder", model: "aux" },
				],
			},
			port,
		)
		const yaml = String(port.configs.get(`${HOME}/.hermes/config.yaml`))
		expect(yaml).toContain('default: "main"')
		expect(yaml).toContain("coder")
		expect(yaml).not.toContain("ignored")
	})

	test("an empty apiKey never writes .env, because that file holds other credentials", async () => {
		const port = fake({ envs: { [`${HOME}/.hermes/.env`]: "TELEGRAM_TOKEN=secret\n" } })
		await writeHermesSettings({ baseUrl: BASE, model: "m" }, port)
		expect(port.envs.get(`${HOME}/.hermes/.env`)).toBe("TELEGRAM_TOKEN=secret\n")
	})

	test("enabling audio without a model is a 400", async () => {
		const answer = await writeHermesSettings(
			{ baseUrl: BASE, model: "m", audio: { enabled: true } },
			fake({}),
		)
		expect(answer.status).toBe(400)
		expect(String(answer.body.error)).toContain("audio.model is required")
	})

	test("disabling audio leaves a foreign stt section alone", async () => {
		const yaml = `${ninesRouterModel}stt:\n  provider: "deepgram"\n  language: "en"\n`
		const port = fake({ configs: { [`${HOME}/.hermes/config.yaml`]: yaml } })
		await writeHermesSettings({ baseUrl: BASE, model: "m", audio: { enabled: false } }, port)
		expect(String(port.configs.get(`${HOME}/.hermes/config.yaml`))).toContain("deepgram")
	})

	test("an unknown profile is a 404 before anything is written", async () => {
		const port = fake({ missingDirs: [`${HOME}/.hermes/profiles/ghost`] })
		const answer = await writeHermesSettings({ baseUrl: BASE, model: "m", profile: "ghost" }, port)
		expect(answer.status).toBe(404)
		expect(port.writes).toEqual([])
	})

	test("the message names the profile when it is not the default one", async () => {
		const port = fake({})
		const answer = await writeHermesSettings({ baseUrl: BASE, model: "m", profile: "work" }, port)
		expect(answer.body.message).toBe('Hermes settings applied to profile "work"!')
	})
})

describe("applying to every profile", () => {
	const profile = (name: string): HermesProfileSummary => ({
		name,
		dir: name === "default" ? `${HOME}/.hermes` : `${HOME}/.hermes/profiles/${name}`,
		isDefault: name === "default",
		displayName: null,
		command: name === "default" ? "hermes" : `hermes -p ${name}`,
		alias: name === "default" ? null : name,
		model: null,
		baseUrl: null,
		has9Router: false,
	})

	test("a profile already pointing here is updated", async () => {
		const port = fake({
			configs: { [`${HOME}/.hermes/config.yaml`]: ninesRouterModel },
			profiles: [profile("default")],
		})
		const answer = await writeHermesSettings(
			{ baseUrl: "http://new:1", model: "m", applyToAll: true },
			port,
		)
		expect(answer.body.updated).toBe(1)
		expect(String(port.configs.get(`${HOME}/.hermes/config.yaml`))).toContain("http://new:1/v1")
	})

	test("a profile on another provider is skipped with a reason, never rewritten", async () => {
		const port = fake({
			configs: { [`${HOME}/.hermes/config.yaml`]: foreignModel },
			profiles: [profile("default")],
		})
		const answer = await writeHermesSettings(
			{ baseUrl: "http://new:1", model: "m", applyToAll: true },
			port,
		)
		expect(answer.body.updated).toBe(0)
		expect(String((answer.body.results as { reason: string }[])[0].reason)).toContain(
			'provider "openai"',
		)
		expect(port.configs.get(`${HOME}/.hermes/config.yaml`)).toBe(foreignModel)
	})

	test("a profile with no model is wired up from this request", async () => {
		const port = fake({ profiles: [profile("default")] })
		const answer = await writeHermesSettings(
			{ baseUrl: BASE, model: "fresh", applyToAll: true },
			port,
		)
		expect(answer.body.updated).toBe(1)
		expect(String(port.configs.get(`${HOME}/.hermes/config.yaml`))).toContain('default: "fresh"')
	})

	test("a bulk apply with no model anywhere is refused up front, as it always was", async () => {
		const port = fake({ profiles: [profile("default")] })
		const answer = await writeHermesSettings({ baseUrl: BASE, applyToAll: true }, port)
		// The guard runs before the bulk branch: without a default model there is nothing to
		// fill a gap with, so the request is a 400 rather than a bulk run that skips everything.
		expect(answer.status).toBe(400)
		expect(answer.body.error).toBe("baseUrl and model are required")
		expect(port.writes).toEqual([])
	})
})

describe("resetting a profile", () => {
	test("a profile with no config is a success that says there is nothing to reset", async () => {
		const answer = await resetHermesSettings(null, fake({}))
		expect(answer.status).toBe(200)
		expect(answer.body.message).toBe("No config file to reset")
	})

	test("blocks this install wrote are removed", async () => {
		const port = fake({ configs: { [`${HOME}/.hermes/config.yaml`]: ninesRouterModel } })
		const answer = await resetHermesSettings(null, port)
		expect(answer.body.removed).toEqual({
			model: true,
			delegation: false,
			auxiliary: [],
			stt: false,
		})
	})

	test("a model on another provider survives, and is reported as kept", async () => {
		const port = fake({ configs: { [`${HOME}/.hermes/config.yaml`]: foreignModel } })
		const answer = await resetHermesSettings(null, port)
		expect(answer.body.removed).toMatchObject({ model: false })
		expect(answer.body.kept).toContain("model")
		expect(port.configs.get(`${HOME}/.hermes/config.yaml`)).toBe(foreignModel)
	})

	test("the message names the profile when it is not the default one", async () => {
		const port = fake({
			configs: { [`${HOME}/.hermes/profiles/work/config.yaml`]: ninesRouterModel },
		})
		const answer = await resetHermesSettings({ profile: "work" }, port)
		expect(answer.body.message).toBe('9router model blocks removed in profile "work"')
	})

	test("an unknown profile is a 404 and writes nothing", async () => {
		const port = fake({ missingDirs: [`${HOME}/.hermes/profiles/ghost`] })
		const answer = await resetHermesSettings({ profile: "ghost" }, port)
		expect(answer.status).toBe(404)
		expect(port.writes).toEqual([])
	})
})
