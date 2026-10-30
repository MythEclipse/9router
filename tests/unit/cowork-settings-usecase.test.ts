import { describe, expect, test } from "vitest"
import type {
	CoworkDependencies,
	CoworkFilesPort,
	CoworkLocalPlugin,
	CoworkMeta,
	CoworkPluginPreset,
} from "../../apps/api/src/application/cowork-settings/manage-cowork-settings.ts"
import {
	readCoworkSettings,
	resetCoworkSettings,
	writeCoworkSettings,
} from "../../apps/api/src/application/cowork-settings/manage-cowork-settings.ts"
import type { CoworkManagedServer } from "../../apps/api/src/domain/cowork-settings.ts"

/**
 * The decisions worth proving, all of which were buried inside a 449-line route:
 *
 * - a reset *empties* the active entry instead of deleting it, because the app indexes that id;
 * - a broken `config.json` is reported, never overwritten — it may hold the user's own servers;
 * - the three plugin lists do not overlap, since one server in two lists is a support ticket;
 * - writes land in the first candidate root, while reads follow whatever the app discovered;
 * - a failed skip-approvals write does not throw away settings that were already written.
 *
 * `cowork-settings.test.ts` covers `domain/cowork-settings.ts`; this file is the layer above it.
 */

const ROOT = "/root/.config/Claude-3p"
const DISCOVERED = "/root/.config/Claude"
const BRIDGE = "http://localhost:20128/api/mcp/"

const PRESETS: CoworkPluginPreset[] = [
	{ name: "linear", url: "https://mcp.linear.app/sse", transport: "sse", toolNames: ["create"] },
]
const LOCALS: CoworkLocalPlugin[] = [{ name: "files", toolNames: ["read", "write"] }]

interface Fake extends CoworkFilesPort {
	readonly files: Map<string, string>
	readonly writes: string[]
	readonly desktop: Record<string, unknown>
}

const fake = (init: {
	files?: Record<string, string>
	installed?: boolean
	readRoot?: string
	desktop?: Record<string, unknown>
	breakSkipWrite?: boolean
}): Fake => {
	const files = new Map(Object.entries(init.files ?? {}))
	const writes: string[] = []
	const desktop: Record<string, unknown> = { ...(init.desktop ?? {}) }
	const readRoot = init.readRoot ?? ROOT

	return {
		files,
		writes,
		desktop,
		readRoot: async () => readRoot,
		writeRoot: () => ROOT,
		isInstalled: async () => init.installed ?? true,
		readJson: async <T extends object>(p: string) => {
			const raw = files.get(p)
			return raw === undefined ? null : (JSON.parse(raw) as T)
		},
		readText: async (p: string) => files.get(p) ?? null,
		writeText: async (p: string, content: string) => {
			if (init.breakSkipWrite && p.endsWith("/config.json")) throw new Error("EACCES")
			writes.push(p)
			files.set(p, content)
		},
		ensureDir: async () => {},
		ensureMeta: async (writeMetaPath: string, readMetaPath: string): Promise<CoworkMeta> => {
			const own = files.get(writeMetaPath)
			if (own) return JSON.parse(own) as CoworkMeta
			const inherited = files.get(readMetaPath)
			const meta = inherited
				? (JSON.parse(inherited) as CoworkMeta)
				: { appliedId: "new-id", entries: [{ id: "new-id", name: "Default" }] }
			files.set(writeMetaPath, JSON.stringify(meta))
			return meta
		},
		configDir: async () => `${readRoot}/configLibrary`,
		writeConfigDir: () => `${ROOT}/configLibrary`,
		metaPath: async () => `${readRoot}/configLibrary/_meta.json`,
		writeMetaPath: () => `${ROOT}/configLibrary/_meta.json`,
		desktopConfig: async () => ({ ...desktop }),
		writeDesktopConfig: async (cfg: Record<string, unknown>) => {
			for (const key of Object.keys(desktop)) delete desktop[key]
			Object.assign(desktop, cfg)
		},
	}
}

const deps = (port: CoworkFilesPort, token: string | null = "tok"): CoworkDependencies => ({
	port,
	pluginPresets: PRESETS,
	localPlugins: LOCALS,
	buildPresetEntries: (plugins): CoworkManagedServer[] =>
		(Array.isArray(plugins) ? plugins : []).flatMap((p: CoworkPluginPreset) =>
			typeof p.url === "string" ? [{ name: p.name, url: p.url, transport: p.transport ?? "sse" }] : [],
		),
	localBridgePrefix: BRIDGE,
	cliTokenHeader: "x-9r-cli-token",
	cliToken: async () => token,
})

const meta = (id: string): string =>
	JSON.stringify({ appliedId: id, entries: [{ id, name: "Default" }] })

describe("reading the card", () => {
	test("a machine with no Claude Desktop is 200 with installed:false", async () => {
		const answer = await readCoworkSettings(deps(fake({ installed: false })))
		expect(answer.status).toBe(200)
		expect(answer.body.installed).toBe(false)
		expect(answer.body.config).toBeNull()
	})

	test("a machine with no library index answers null, not an error", async () => {
		const answer = await readCoworkSettings(deps(fake({})))
		expect(answer.body.installed).toBe(true)
		expect((answer.body.cowork as { appliedId: unknown }).appliedId).toBeNull()
		expect(answer.body.configPath).toBeNull()
	})

	test("one managed server appears in exactly one of the three lists", async () => {
		const config = {
			managedMcpServers: [
				{ name: "linear", url: "https://mcp.linear.app/sse" },
				{ name: "files", url: `${BRIDGE}files/sse` },
				{ name: "mine", url: "https://example.com/sse", custom: true },
			],
		}
		const port = fake({
			files: {
				[`${ROOT}/configLibrary/_meta.json`]: meta("abc"),
				[`${ROOT}/configLibrary/abc.json`]: JSON.stringify(config),
			},
		})
		const cowork = (await readCoworkSettings(deps(port))).body.cowork as {
			plugins: { name: string }[]
			localPlugins: string[]
			customPlugins: { name: string }[]
		}
		expect(cowork.plugins.map((p) => p.name)).toEqual(["linear"])
		expect(cowork.localPlugins).toEqual(["files"])
		expect(cowork.customPlugins.map((p) => p.name)).toEqual(["mine"])
	})

	test("a preset server reports the preset's curated tool names, not the policy keys", async () => {
		const config = {
			managedMcpServers: [
				{ name: "linear", url: "https://x", toolPolicy: { "linear-create": "allow" } },
			],
		}
		const port = fake({
			files: {
				[`${ROOT}/configLibrary/_meta.json`]: meta("abc"),
				[`${ROOT}/configLibrary/abc.json`]: JSON.stringify(config),
			},
		})
		const cowork = (await readCoworkSettings(deps(port))).body.cowork as {
			plugins: { toolNames: string[] }[]
		}
		expect(cowork.plugins[0].toolNames).toEqual(["create"])
	})

	test("the read follows the root the app actually discovered", async () => {
		const port = fake({
			readRoot: DISCOVERED,
			files: {
				[`${DISCOVERED}/configLibrary/_meta.json`]: meta("old"),
				[`${DISCOVERED}/configLibrary/old.json`]: JSON.stringify({ inferenceModels: [] }),
			},
		})
		const answer = await readCoworkSettings(deps(port))
		expect(answer.body.configPath).toBe(`${DISCOVERED}/configLibrary/old.json`)
	})
})

describe("writing the config", () => {
	test("a missing key or URL is a 400 that names both", async () => {
		const answer = await writeCoworkSettings({ baseUrl: BRIDGE }, deps(fake({})))
		expect(answer.status).toBe(400)
		expect(answer.body.error).toBe("baseUrl and apiKey are required")
	})

	test("no models is a 400, because Cowork would have nothing to route", async () => {
		const answer = await writeCoworkSettings(
			{ baseUrl: "http://x", apiKey: "k", models: [] },
			deps(fake({})),
		)
		expect(answer.status).toBe(400)
		expect(answer.body.error).toBe("At least one model is required")
	})

	test("3p mode is set once and reported as bootstrapped", async () => {
		const port = fake({})
		const answer = await writeCoworkSettings(
			{ baseUrl: "http://x", apiKey: "k", models: ["m"] },
			deps(port),
		)
		expect(answer.body.bootstrapped).toBe(true)
		expect(port.desktop.deploymentMode).toBe("3p")

		const again = await writeCoworkSettings(
			{ baseUrl: "http://x", apiKey: "k", models: ["m"] },
			deps(port),
		)
		expect(again.body.bootstrapped).toBe(false)
	})

	test("the write lands in the first candidate root even when another was discovered", async () => {
		const port = fake({
			readRoot: DISCOVERED,
			files: { [`${DISCOVERED}/configLibrary/_meta.json`]: meta("old") },
		})
		const answer = await writeCoworkSettings(
			{ baseUrl: "http://x", apiKey: "k", models: ["m"] },
			deps(port),
		)
		expect(String(answer.body.configPath).startsWith(`${ROOT}/configLibrary/`)).toBe(true)
	})

	test("an inherited entry id is reused, so the app keeps reading the same entry", async () => {
		const port = fake({
			readRoot: DISCOVERED,
			files: { [`${DISCOVERED}/configLibrary/_meta.json`]: meta("old") },
		})
		const answer = await writeCoworkSettings(
			{ baseUrl: "http://x", apiKey: "k", models: ["m"] },
			deps(port),
		)
		expect(answer.body.configPath).toBe(`${ROOT}/configLibrary/old.json`)
	})

	test("local bridge entries carry the CLI token and both tool-name forms", async () => {
		const port = fake({})
		await writeCoworkSettings(
			{ baseUrl: "http://x", apiKey: "k", models: ["m"], localPlugins: ["files"], plugins: [] },
			deps(port),
		)
		const written = JSON.parse(String(port.files.get(`${ROOT}/configLibrary/new-id.json`)))
		const entry = written.managedMcpServers[0]
		expect(entry.url).toBe(`${BRIDGE}files/sse`)
		expect(entry.toolPolicy).toEqual({
			read: "allow",
			"files-read": "allow",
			write: "allow",
			"files-write": "allow",
		})
	})

	test("an empty plugins array is honoured, because it means 'all off'", async () => {
		const port = fake({})
		await writeCoworkSettings(
			{ baseUrl: "http://x", apiKey: "k", models: ["m"], plugins: [] },
			deps(port),
		)
		const written = JSON.parse(String(port.files.get(`${ROOT}/configLibrary/new-id.json`)))
		expect(written.managedMcpServers).toBeUndefined()
	})

	test("a custom plugin cannot smuggle a stdio command", async () => {
		const port = fake({})
		await writeCoworkSettings(
			{
				baseUrl: "http://x",
				apiKey: "k",
				models: ["m"],
				plugins: [],
				customPlugins: [{ name: "evil", command: "rm -rf /" }],
			},
			deps(port),
		)
		const written = JSON.parse(String(port.files.get(`${ROOT}/configLibrary/new-id.json`)))
		expect(written.managedMcpServers ?? []).toEqual([])
	})

	test("the shipped security block is always written", async () => {
		const port = fake({})
		await writeCoworkSettings({ baseUrl: "http://x", apiKey: "k", models: ["m"] }, deps(port))
		const written = JSON.parse(String(port.files.get(`${ROOT}/configLibrary/new-id.json`)))
		expect(written.inferenceProvider).toBe("gateway")
		expect(Object.keys(written)).toEqual(
			expect.arrayContaining(["inferenceGatewayBaseUrl", "inferenceModels"]),
		)
	})

	test("a failed skip-approvals write is reported but does not fail the request", async () => {
		const port = fake({ breakSkipWrite: true })
		const answer = await writeCoworkSettings(
			{ baseUrl: "http://x", apiKey: "k", models: ["m"] },
			deps(port),
		)
		expect(answer.status).toBe(200)
		expect(answer.body.success).toBe(true)
		expect(answer.body.skipApprovals).toEqual({ error: "EACCES" })
	})

	test("a config.json that does not parse is reported, not overwritten", async () => {
		const port = fake({ files: { [`${ROOT}/config.json`]: "{ not json" } })
		const answer = await writeCoworkSettings(
			{ baseUrl: "http://x", apiKey: "k", models: ["m"], plugins: [] },
			deps(port),
		)
		// The settings write succeeded; only the skip-approvals step refused to clobber the file.
		expect(answer.status).toBe(200)
		// The message keeps the parser's own words: an operator reading it knows *why* the file was
		// skipped, which "not valid JSON" alone would not tell them.
		expect(String((answer.body.skipApprovals as { error: string }).error)).toContain("JSON")
		expect(port.files.get(`${ROOT}/config.json`)).toBe("{ not json")
	})
})

describe("resetting the config", () => {
	test("no active entry is already reset, so it is a success", async () => {
		const answer = await resetCoworkSettings(deps(fake({})))
		expect(answer.body.message).toBe("No active config to reset")
	})

	test("the active entry is emptied, never deleted", async () => {
		const port = fake({
			files: {
				[`${ROOT}/configLibrary/_meta.json`]: meta("abc"),
				[`${ROOT}/configLibrary/abc.json`]: JSON.stringify({ inferenceProvider: "gateway" }),
			},
		})
		const answer = await resetCoworkSettings(deps(port))
		expect(answer.body.message).toBe("Cowork config reset")
		expect(JSON.parse(String(port.files.get(`${ROOT}/configLibrary/abc.json`)))).toEqual({})
	})

	test("an entry that does not exist yet is not created by the reset", async () => {
		const port = fake({ files: { [`${ROOT}/configLibrary/_meta.json`]: meta("ghost") } })
		await resetCoworkSettings(deps(port))
		expect(port.files.has(`${ROOT}/configLibrary/ghost.json`)).toBe(false)
	})

	test("skip-approvals are cleared for the managed servers", async () => {
		const port = fake({
			files: {
				[`${ROOT}/configLibrary/_meta.json`]: meta("abc"),
				[`${ROOT}/config.json`]: JSON.stringify({ operonSkipMcpApprovals: { files: true } }),
			},
		})
		await resetCoworkSettings(deps(port))
		expect(JSON.parse(String(port.files.get(`${ROOT}/config.json`))).operonSkipMcpApprovals).toEqual(
			{},
		)
	})
})
