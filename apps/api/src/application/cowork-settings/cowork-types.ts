/** Cowork settings: shared types. */
import type { CoworkManagedServer } from "../../domain/cowork-settings.ts"
/** One plugin preset, as the dashboard ships it. */
export interface CoworkPluginPreset {
	readonly name: string
	readonly url?: string
	readonly transport?: string
	readonly toolNames?: readonly string[]
}

/** A stdio plugin this app bridges itself, served from its own `/api/mcp/{name}/sse`. */
export interface CoworkLocalPlugin {
	readonly name: string
	readonly toolNames?: readonly string[]
}

/** A config-library entry, as Claude Desktop indexes it. */
export interface CoworkMeta {
	readonly appliedId: string
	readonly entries: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

/** The config-library files this flow is allowed to read and write. */
export interface CoworkFilesPort {
	/** The directory the app actually reads from, or the first candidate when none exists yet. */
	readonly readRoot: () => Promise<string>
	/** The directory a write must land in: the first candidate, never a discovered one. */
	readonly writeRoot: () => string
	readonly isInstalled: () => Promise<boolean>
	readonly readJson: <T extends object>(filePath: string) => Promise<T | null>
	readonly readText: (filePath: string) => Promise<string | null>
	readonly writeText: (filePath: string, content: string) => Promise<void>
	readonly ensureDir: (dir: string) => Promise<void>
	/** The id Claude Desktop will read; created on first use and reused after that. */
	readonly ensureMeta: (writeMetaPath: string, readMetaPath: string) => Promise<CoworkMeta>
	readonly configDir: () => Promise<string>
	readonly writeConfigDir: () => string
	readonly metaPath: () => Promise<string>
	readonly writeMetaPath: () => string
	/** The *first-party* Desktop config — a different file from the Cowork one. */
	readonly desktopConfig: () => Promise<Record<string, unknown>>
	readonly writeDesktopConfig: (cfg: Record<string, unknown>) => Promise<void>
}

export interface CoworkDependencies {
	readonly port: CoworkFilesPort
	readonly pluginPresets: readonly CoworkPluginPreset[]
	readonly localPlugins: readonly CoworkLocalPlugin[]
	/** Builds preset entries; a web constant today, injected so the assembly is testable. */
	readonly buildPresetEntries: (plugins: unknown) => CoworkManagedServer[]
	/** The base URL of this app's inline MCP bridge, e.g. `http://localhost:20128/api/mcp/`. */
	readonly localBridgePrefix: string
	readonly cliTokenHeader: string
	/** `null` means "could not read a machine id" — the entries then go out without auth. */
	readonly cliToken: () => Promise<string | null>
}

export interface CoworkAnswer {
	readonly status: number
	readonly body: Record<string, unknown>
}
