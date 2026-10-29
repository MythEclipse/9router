import {
	type BaseUrlSuffix,
	NOTHING_TO_RESET,
	normaliseBaseUrl,
	pointsAtThisInstall,
	readToolSettings,
	removeInstallEntry,
	settingsFileText,
	THIS_INSTALL_HOSTS,
	type ToolSettingsInput,
} from "../../domain/cli-tool-settings.ts"

/**
 * Connecting a CLI tool to this install.
 *
 * Every tool's screen does the same three things — is it installed, does it point here, and
 * wire it to here — so the sequence lives once and each tool supplies only its own file
 * layout. The tool's own format is a host concern; the decisions are not.
 */

/** What a tool's own config file looks like, as far as this flow cares. */
export interface ToolConfigPort {
	/** Where the config lives, for the screen to show the operator. */
	readonly path: string
	/** The config as read, or null when there is no file yet. */
	readonly read: () => Promise<Record<string, unknown> | null>
	/**
	 * The config for a read-modify-write, which must *fail* rather than answer null when the
	 * file exists but cannot be parsed.
	 *
	 * The difference is data loss: `read` answering null for a corrupt file means the write
	 * that follows starts from `{}` and silently drops every setting the operator had. The
	 * host implements this by rethrowing anything that is not "file not found".
	 */
	readonly readForWrite: () => Promise<Record<string, unknown>>
	readonly write: (text: string) => Promise<void>
	/** Which spelling of the base URL this tool wants. */
	readonly baseUrlSuffix: BaseUrlSuffix
	/** The keys that mean "this install" in this tool's format. */
	readonly installKeys: readonly string[]
	/** The base URL already stored, if any — the tool's config nests it differently. */
	readonly storedBaseUrl: (config: Record<string, unknown> | null) => string | null
	/** Applies this install's settings to the config, in the tool's own shape. */
	readonly apply: (
		config: Record<string, unknown>,
		input: ToolSettingsInput,
	) => Record<string, unknown>
}

export interface ToolSettingsDeps {
	readonly isInstalled: () => Promise<boolean>
	readonly config: ToolConfigPort
	/** Written after the main config, on a best-effort basis. */
	readonly sideWrites?: readonly ((input: ToolSettingsInput) => Promise<void>)[]
	readonly sideRemovals?: readonly (() => Promise<void>)[]
	readonly notInstalledMessage: string
	readonly installUrl?: string
	readonly appliedMessage: string
	readonly resetMessage: string
}

export interface ToolSettingsAnswer {
	readonly ok: boolean
	readonly status: number
	readonly body: Record<string, unknown>
}

/**
 * `GET /api/cli-tools/<tool>-settings`.
 *
 * An uninstalled tool answers 200 with `installed: false`, not 404: the screen needs to render
 * the "install it first" panel, and a 404 reads as "this endpoint does not exist".
 */
export async function readToolSettingsStatus(deps: ToolSettingsDeps): Promise<ToolSettingsAnswer> {
	if (!(await deps.isInstalled())) return notInstalled(deps)

	const config = await deps.config.read()
	const stored = deps.config.storedBaseUrl(config)
	return {
		ok: true,
		status: 200,
		body: {
			installed: true,
			settings: { auth: config ? Object.keys(config) : [] },
			has9Router: pointsAtThisInstall(stored, THIS_INSTALL_HOSTS),
			authPath: deps.config.path,
		},
	}
}

/**
 * `POST /api/cli-tools/<tool>-settings` — { baseUrl, apiKey, model }.
 *
 * The main config is written first and the side writes after; a side write that fails does not
 * fail the request, because the tool already works with what was written. Refusing the whole
 * write over an editor's settings file would leave the operator with a tool they configured
 * and a screen telling them they did not.
 */
export async function writeToolSettings(
	body: unknown,
	deps: ToolSettingsDeps,
): Promise<ToolSettingsAnswer> {
	const parsed = readToolSettings(body)
	if (!parsed.ok || !parsed.input) {
		return { ok: false, status: 400, body: { error: parsed.error } }
	}
	const input = parsed.input

	try {
		if (!(await deps.isInstalled())) {
			return { ok: false, status: 400, body: notInstalled(deps).body }
		}

		const existing = await deps.config.readForWrite()
		const spelled = {
			...input,
			baseUrl: normaliseBaseUrl(input.baseUrl, deps.config.baseUrlSuffix),
		}
		await deps.config.write(settingsFileText(deps.config.apply(existing, spelled)))

		for (const sideWrite of deps.sideWrites ?? []) {
			try {
				await sideWrite(input)
			} catch {
				/* the tool works without this; a failure here is not the operator's problem */
			}
		}

		return {
			ok: true,
			status: 200,
			body: { success: true, message: deps.appliedMessage, authPath: deps.config.path },
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error"
		return { ok: false, status: 500, body: { error: message } }
	}
}

/**
 * `DELETE /api/cli-tools/<tool>-settings`.
 *
 * Removing from a file that was never there is a success with a different message, not a 404:
 * the operator asked for the tool to stop pointing here, and it already does not.
 */
export async function resetToolSettings(deps: ToolSettingsDeps): Promise<ToolSettingsAnswer> {
	try {
		const config = await deps.config.read()
		if (!config) {
			return { ok: true, status: 200, body: { success: true, message: NOTHING_TO_RESET } }
		}

		removeInstallEntry(config, deps.config.installKeys)
		await deps.config.write(settingsFileText(config))

		for (const sideRemoval of deps.sideRemovals ?? []) {
			try {
				await sideRemoval()
			} catch {
				/* see writeToolSettings: a side removal is best-effort */
			}
		}

		return { ok: true, status: 200, body: { success: true, message: deps.resetMessage } }
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error"
		return { ok: false, status: 500, body: { error: message } }
	}
}

function notInstalled(deps: ToolSettingsDeps): ToolSettingsAnswer {
	return {
		ok: true,
		status: 200,
		body: {
			installed: false,
			settings: null,
			message: deps.notInstalledMessage,
			...(deps.installUrl ? { installUrl: deps.installUrl } : {}),
		},
	}
}
