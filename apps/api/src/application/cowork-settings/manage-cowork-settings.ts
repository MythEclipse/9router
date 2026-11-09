/** Cowork settings. (Types in `cowork-types.ts`, helpers in `cowork-helpers.ts`.) */
import {
	bareToolNames,
	type CoworkConfig,
	type CoworkManagedServer,
	coworkHasThisInstall,
	normaliseCoworkModels,
	normaliseCustomPlugins,
	readCoworkModels,
} from "../../domain/cowork-settings.ts"
import type { CoworkAnswer, CoworkDependencies, CoworkMeta } from "./cowork-types.ts"

export type {
	CoworkAnswer,
	CoworkDependencies,
	CoworkFilesPort,
	CoworkLocalPlugin,
	CoworkMeta,
	CoworkPluginPreset,
} from "./cowork-types.ts"

import {
	bootstrapDeploymentMode,
	bridgeEntries,
	buildConfig,
	cleanupDesktopLegacy,
	customEntries,
	fail,
	messageOf,
	withAuth,
	writeSkipApprovals,
} from "./cowork-helpers.ts"

async function readAnswer(deps: CoworkDependencies): Promise<CoworkAnswer> {
	const { port } = deps
	if (!(await port.isInstalled())) {
		return {
			status: 200,
			body: {
				installed: false,
				config: null,
				message: "Claude Desktop (Cowork mode) not detected",
			},
		}
	}

	const meta = await port.readJson<CoworkMeta>(await port.metaPath())
	const appliedId = meta?.appliedId ?? null
	const configDir = await port.configDir()
	const configPath = appliedId ? `${configDir}/${appliedId}.json` : null
	const config = configPath ? await port.readJson<CoworkConfig>(configPath) : null

	const managed = Array.isArray(config?.managedMcpServers) ? config.managedMcpServers : []
	const localNames = new Set(deps.localPlugins.map((plugin) => plugin.name))
	const isLocalBridge = (server: CoworkManagedServer): boolean =>
		localNames.has(server.name) && typeof server.url === "string" && server.url.includes("/api/mcp/")

	const presetNames = new Set(deps.pluginPresets.map((preset) => preset.name))

	return {
		status: 200,
		body: {
			installed: true,
			config,
			has9Router: coworkHasThisInstall(config),
			configPath,
			cowork: {
				appliedId,
				baseUrl: config?.inferenceGatewayBaseUrl ?? null,
				models: readCoworkModels(config),
				provider: config?.inferenceProvider ?? null,
				plugins: managed
					.filter((server) => !server.custom && !isLocalBridge(server))
					.map((server) => {
						// A shipped preset knows its own tool names, and that list is curated; the policy
						// keys in the file are only a fallback for a server we do not know.
						const preset = deps.pluginPresets.find((entry) => entry.name === server.name)
						const fromPolicy = bareToolNames(
							server.name,
							server.toolPolicy ? Object.keys(server.toolPolicy) : [],
						)
						return {
							name: server.name,
							url: server.url,
							transport: server.transport,
							oauth: Boolean(server.oauth),
							toolNames: preset && Array.isArray(preset.toolNames) ? preset.toolNames : fromPolicy,
						}
					}),
				localPlugins: managed.filter(isLocalBridge).map((server) => server.name),
				customPlugins: managed
					.filter(
						(server) => server.custom || (!localNames.has(server.name) && !presetNames.has(server.name)),
					)
					.map((server) => ({
						name: server.name,
						url: server.url,
						transport: server.transport,
						custom: true,
					})),
			},
			defaultPlugins: deps.pluginPresets,
			localStdioPlugins: deps.localPlugins,
		},
	}
}

export async function readCoworkSettings(deps: CoworkDependencies): Promise<CoworkAnswer> {
	try {
		return await readAnswer(deps)
	} catch (error) {
		return fail(500, messageOf(error, "Failed to read cowork settings"))
	}
}
export async function writeCoworkSettings(
	body: unknown,
	deps: CoworkDependencies,
): Promise<CoworkAnswer> {
	const { port } = deps
	try {
		const input = (body ?? {}) as {
			baseUrl?: unknown
			apiKey?: unknown
			models?: unknown
			plugins?: unknown
			localPlugins?: unknown
			customPlugins?: unknown
		}
		const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl : ""
		const secret = typeof input.apiKey === "string" ? input.apiKey : ""
		if (!baseUrl || !secret) return fail(400, "baseUrl and apiKey are required")

		const models = normaliseCoworkModels(input.models)
		if (models.length === 0) return fail(400, "At least one model is required")

		// An empty array means the user switched every plugin off; only `undefined` falls back to
		// the shipped defaults.
		const presets = Array.isArray(input.plugins) ? input.plugins : deps.pluginPresets
		const localNames = Array.isArray(input.localPlugins) ? input.localPlugins : []

		const servers = [
			...deps.buildPresetEntries(presets),
			...(await withAuth(bridgeEntries(localNames, deps), deps)),
			...(await withAuth(customEntries(normaliseCustomPlugins(input.customPlugins)), deps)),
		]

		const bootstrapped = await bootstrapDeploymentMode(port)
		const meta = await port.ensureMeta(port.writeMetaPath(), await port.metaPath())
		const configPath = `${port.writeConfigDir()}/${meta.appliedId}.json`
		await port.ensureDir(port.writeConfigDir())
		await port.writeText(
			configPath,
			JSON.stringify(buildConfig({ baseUrl, secret, models, servers }), null, 2),
		)

		// Each of these is best-effort and reported separately: the settings above are already
		// written, so a failure here must not turn a success into a 500.
		let skipApprovals: unknown
		try {
			skipApprovals = await writeSkipApprovals(port, servers)
		} catch (error) {
			skipApprovals = { error: messageOf(error, "could not write skip-approvals") }
		}
		try {
			await cleanupDesktopLegacy(
				port,
				deps.localPlugins.map((plugin) => plugin.name),
			)
		} catch {
			// The legacy entries are harmless; leaving them is better than failing the write.
		}

		return {
			status: 200,
			body: {
				success: true,
				bootstrapped,
				message: bootstrapped
					? "Cowork enabled (3p mode set). Quit & reopen Claude Desktop."
					: "Cowork settings applied. Quit & reopen Claude Desktop.",
				configPath,
				skipApprovals,
				localMcp: { applied: localNames, via: "3p-sse-bridge" },
			},
		}
	} catch (error) {
		return fail(500, messageOf(error, "Failed to apply cowork settings"))
	}
}
/**
 * Reset the active config.
 *
 * The file is emptied, not removed — see the note at the top of this file. A machine with no
 * library at all is already "reset", so it answers success rather than 404.
 */
export async function resetCoworkSettings(deps: CoworkDependencies): Promise<CoworkAnswer> {
	const { port } = deps
	try {
		const meta = await port.readJson<CoworkMeta>(await port.metaPath())
		if (!meta?.appliedId) {
			return { status: 200, body: { success: true, message: "No active config to reset" } }
		}
		const configPath = `${await port.configDir()}/${meta.appliedId}.json`
		const existing = await port.readText(configPath)
		if (existing !== null) await port.writeText(configPath, JSON.stringify({}, null, 2))

		try {
			await writeSkipApprovals(port, [])
		} catch {
			// Nothing to clear is the normal case here.
		}
		try {
			await cleanupDesktopLegacy(
				port,
				deps.localPlugins.map((plugin) => plugin.name),
			)
		} catch {
			// Same: a config that cannot be read has no legacy entries to remove.
		}
		return { status: 200, body: { success: true, message: "Cowork config reset" } }
	} catch (error) {
		return fail(500, messageOf(error, "Failed to reset cowork settings"))
	}
}
