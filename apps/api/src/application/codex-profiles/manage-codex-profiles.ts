/**
 * Codex profiles: the operator's `~/.codex/*.config.toml` files, listed, written and deleted.
 *
 * The rules already live in `domain/codex-profiles.ts` — what a name may be, what a model may
 * be, what the TOML looks like. This file adds the three things the route did inline: deciding
 * that a missing directory means no profiles rather than an error, deciding that an unreadable
 * profile still deserves a row, and turning a refused write into a status.
 *
 * Filesystem access stays behind a port, so every one of those decisions can be tested without
 * a home directory — including the two that only happen on a bad day.
 */

import {
	codexProfile,
	codexProfileFile,
	codexProfileToml,
	isValidCodexModel,
	isValidProfileName,
	normaliseProfileName,
	profileNameFromFile,
	readProfileModel,
} from "../../domain/codex-profiles.ts"

/** The directory operations the profile flow needs. */
export interface CodexProfilesPort {
	/** Every entry in `~/.codex`, or null when the directory does not exist yet. */
	readonly listFiles: () => Promise<string[] | null>
	/** One profile file's contents, or null when it cannot be read. */
	readonly readFile: (file: string) => Promise<string | null>
	readonly writeFile: (file: string, content: string) => Promise<void>
	/** Removes one profile file; false when it was not there. */
	readonly removeFile: (file: string) => Promise<boolean>
}

/** A flat answer, matching the other CLI-tool answers. */
export interface CodexProfilesAnswer {
	readonly status: number
	readonly body: Record<string, unknown>
}

const failed = (error: unknown, fallback: string): CodexProfilesAnswer => ({
	status: 500,
	body: { error: error instanceof Error ? error.message : fallback },
})

/**
 * Every profile in the directory, sorted by name.
 *
 * Two tolerances are deliberate. A missing `~/.codex` answers an empty list: the screen asks
 * "what profiles do I have" before the operator has any, and an error there would look like a
 * broken install. A profile whose file cannot be read is still listed, with no model — the
 * operator made that file, so hiding it would make the directory and the screen disagree.
 */
export async function listCodexProfiles(port: CodexProfilesPort): Promise<CodexProfilesAnswer> {
	let files: string[] | null
	try {
		files = await port.listFiles()
	} catch (error) {
		return failed(error, "Failed to read profiles")
	}
	if (files === null) return { status: 200, body: { profiles: [] } }

	const names = files
		.map((file) => profileNameFromFile(file))
		.filter((name): name is string => name !== null)

	const profiles = await Promise.all(
		names.map(async (name) => {
			const content = await port.readFile(codexProfileFile(name))
			return codexProfile(name, content === null ? "" : readProfileModel(content))
		}),
	)

	profiles.sort((a, b) => a.name.localeCompare(b.name))
	return { status: 200, body: { profiles } }
}

/**
 * Create or overwrite one profile.
 *
 * The two refusals keep their own messages rather than sharing one: the name rule and the model
 * rule fail for different reasons, and the screen shows the message next to the field.
 */
export async function writeCodexProfile(
	body: unknown,
	port: CodexProfilesPort,
): Promise<CodexProfilesAnswer> {
	const input = (body ?? {}) as { name?: unknown; model?: unknown }

	const name = normaliseProfileName(input.name)
	if (!isValidProfileName(name)) {
		return {
			status: 400,
			body: {
				error:
					"Profile name can only contain alphanumeric characters, dashes, underscores and cannot be 'config'",
			},
		}
	}

	const model = typeof input.model === "string" ? input.model.trim() : ""
	if (!isValidCodexModel(model)) {
		return { status: 400, body: { error: "Invalid model name" } }
	}

	try {
		await port.writeFile(codexProfileFile(name), codexProfileToml(name, model))
		return { status: 200, body: { success: true, profile: codexProfile(name, model) } }
	} catch (error) {
		return failed(error, "Failed to save profile")
	}
}

/**
 * Remove one profile.
 *
 * An absent file is a 404 rather than a quiet success: the operator asked to delete something
 * specific, and answering "done" when nothing was there hides a stale screen.
 */
export async function deleteCodexProfile(
	body: unknown,
	port: CodexProfilesPort,
): Promise<CodexProfilesAnswer> {
	const name = normaliseProfileName((body as { name?: unknown } | null)?.name)
	if (!isValidProfileName(name)) {
		return { status: 400, body: { error: "Invalid profile name" } }
	}

	try {
		const removed = await port.removeFile(codexProfileFile(name))
		if (!removed) return { status: 404, body: { error: "Profile not found" } }
		return { status: 200, body: { success: true, message: `Profile ${name} deleted` } }
	} catch (error) {
		return failed(error, "Failed to delete profile")
	}
}
