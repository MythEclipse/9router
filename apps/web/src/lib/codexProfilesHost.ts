import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { CodexProfilesPort } from "9router-api/application/codex-profiles/manage-codex-profiles"

/**
 * The Codex profiles directory, as the application layer wants to see it.
 *
 * Every "cannot" that the port is allowed to report is decided here rather than thrown: a
 * missing `~/.codex` is an empty list, an unreadable profile file is a profile with no model,
 * and a delete of a file that is not there is `false`. Anything else is a real failure and is
 * left to propagate — the use-case turns it into a 500, which is the right answer for a
 * directory that exists but cannot be read.
 */

const codexDir = () => path.join(os.homedir(), ".codex")

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT"

export const codexProfilesPort: CodexProfilesPort = {
	listFiles: async () => {
		try {
			return await fs.readdir(codexDir())
		} catch (error) {
			if (isMissing(error)) return null
			throw error
		}
	},

	readFile: async (file) => {
		try {
			return await fs.readFile(path.join(codexDir(), file), "utf-8")
		} catch {
			return null
		}
	},

	writeFile: async (file, content) => {
		await fs.mkdir(codexDir(), { recursive: true })
		await fs.writeFile(path.join(codexDir(), file), content, "utf-8")
	},

	removeFile: async (file) => {
		try {
			await fs.unlink(path.join(codexDir(), file))
			return true
		} catch (error) {
			if (isMissing(error)) return false
			throw error
		}
	},
}
