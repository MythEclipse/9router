/**
 * Hermes profiles: which directory a name means, and what a directory has to look like.
 *
 * A Hermes profile is a whole home directory:
 *
 * - `~/.hermes` — the default profile, and the install root
 * - `~/.hermes/profiles/<name>` — a named profile
 *
 * None of this touches the filesystem. It answers the two questions that decide whether a
 * filesystem call is allowed at all: is this a name we will turn into a path, and is this
 * directory a profile. Both are security-relevant, which is why they live here with tests rather
 * than in a route beside the `fs` calls they guard.
 */

import path from "node:path"

/**
 * A profile name, before it becomes a directory name and a shell alias.
 *
 * Restricted to `[A-Za-z0-9_-]` starting with an alphanumeric: the name appears in
 * `hermes -p <name>` and as `~/.local/bin/<name>`, so anything a shell or path would interpret
 * is refused here rather than escaped later.
 */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * The files that make a directory a profile.
 *
 * Hermes only treats a directory under `profiles/` as a profile when it carries one of these; a
 * bare directory left behind by logging or cron is ignored, and so is it ignored here — otherwise
 * the screen would offer a profile that the CLI cannot run.
 */
export const IDENTITY_FILES = [
	"config.yaml",
	".env",
	"SOUL.md",
	"profile.yaml",
	"auth.json",
	"state.db",
] as const

/** One resolved profile home. */
export interface HermesHome {
	readonly name: string
	readonly dir: string
	readonly configPath: string
	readonly envPath: string
	readonly isDefault: boolean
}

/** Where the install root is, given an optional override (tests pass one). */
export const hermesRoot = (root: string | undefined, home: string): string =>
	root || path.join(home, ".hermes")

/** Where named profiles live under a root. */
export const profilesRoot = (root: string): string => path.join(root, "profiles")

/**
 * Whether a name may be used as a profile name.
 *
 * `default` is refused as a *name* because it is the root — a `profiles/default` directory would
 * be a second, confusing way to spell the same thing, and Hermes would not read it as a profile.
 */
export const isValidHermesProfileName = (name: unknown): name is string =>
	typeof name === "string" && PROFILE_NAME_RE.test(name) && name.toLowerCase() !== "default"

/** A refused name, with the message the caller should see. */
export class InvalidProfileNameError extends Error {
	constructor() {
		super("Invalid Hermes profile name (letters, digits, - and _ only, max 64 chars)")
		this.name = "InvalidProfileNameError"
	}
}

/**
 * The directory a profile name means.
 *
 * An empty or `default` name is the install root. Anything else is validated, then resolved and
 * checked for containment — the containment test is not redundant with the name regex: it is the
 * guard that still holds if the regex is ever relaxed.
 *
 * Throws `InvalidProfileNameError` rather than returning a result so a caller cannot forget to
 * check; the message is the one the screen shows.
 */
export function resolveHermesHome(profile: unknown, root: string, home: string): HermesHome {
	const base = hermesRoot(root, home)
	const name = typeof profile === "string" ? profile.trim() : ""

	if (!name || name === "default") {
		return {
			name: "default",
			dir: base,
			configPath: path.join(base, "config.yaml"),
			envPath: path.join(base, ".env"),
			isDefault: true,
		}
	}

	if (!isValidHermesProfileName(name)) throw new InvalidProfileNameError()

	const under = path.resolve(profilesRoot(base))
	const dir = path.resolve(path.join(under, name))
	if (dir !== under && !dir.startsWith(under + path.sep)) {
		throw new InvalidProfileNameError()
	}

	return {
		name,
		dir,
		configPath: path.join(dir, "config.yaml"),
		envPath: path.join(dir, ".env"),
		isDefault: false,
	}
}

/** The name an operator sees for a profile, falling back to the directory name. */
export const displayNameFrom = (profileYaml: string): string | null => {
	const match = profileYaml.match(/^display_name:[ \t]*["']?([^"'\r\n]+)["']?/m)
	return match ? match[1].trim() : null
}

/** What the operator types to run a profile. */
export const commandFor = (name: string, isDefault: boolean): string =>
	isDefault ? "hermes" : `hermes -p ${name}`
