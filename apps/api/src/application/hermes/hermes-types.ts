/** Hermes settings: shared types. */
/** The provider name this install writes into every block. */
const PROVIDER_NAME = "9router"
const API_KEY_ENV = "OPENAI_API_KEY"

/** One resolved profile home, as this layer passes it back to the port. */
export interface HermesHomeView {
	readonly name: string
	readonly dir: string
	readonly configPath: string
	readonly envPath: string
	readonly isDefault: boolean
}

/** One profile as the screen lists it. */
export interface HermesProfileSummary {
	readonly name: string
	readonly dir: string
	readonly isDefault: boolean
	readonly displayName: string | null
	readonly command: string
	readonly alias: string | null
	readonly model: string | null
	readonly baseUrl: string | null
	readonly has9Router: boolean
}

/** The file operations the Hermes flow needs, per profile home. */
export interface HermesFilesPort {
	/**
	 * The directory a profile name means, or the refusal.
	 *
	 * Returns the refusal rather than throwing so this layer can answer 400 with the message the
	 * domain chose, instead of catching an error type it would have to know about.
	 */
	readonly resolve: (profile: unknown) => { home: HermesHomeView } | { error: string }
	/** True when the named profile's home is a directory that exists. */
	readonly dirExists: (dir: string) => Promise<boolean>
	/** `config.yaml`, or "" when absent. Other failures are real and propagate. */
	readonly readConfig: (home: HermesHomeView) => Promise<string>
	/** `.env`, or "" when absent. */
	readonly readEnv: (home: HermesHomeView) => Promise<string>
	/** Creates the directory when the home is the default one, then writes `config.yaml`. */
	readonly writeConfig: (home: HermesHomeView, yaml: string) => Promise<void>
	/** Upserts only the API key line, and only when a key was supplied. */
	readonly writeEnvKey: (home: HermesHomeView, apiKey: string) => Promise<void>
	/** Used by `reset` to tell "no config yet" from a real read failure. */
	readonly configMissing: (home: HermesHomeView) => Promise<boolean>
	readonly isInstalled: () => Promise<boolean>
	/** Every profile on this machine, default first. */
	readonly listProfiles: () => Promise<HermesProfileSummary[]>
}

/** A flat answer, matching the other CLI-tool answers. */
export interface HermesAnswer {
	readonly status: number
	readonly body: Record<string, unknown>
}

/** One slot a write touches: `default`, `delegation`, or an auxiliary role. */
export interface Selection {
	readonly role: string
	readonly model: string
}
