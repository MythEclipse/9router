/**
 * Filesystem and HTTP adapters for the changelog use-case.
 *
 * Isolated here so the use-case stays testable without touching disk or network.
 */
import fs from "node:fs"
import path from "node:path"
import { type ChangelogSource, createChangelogSource } from "../application/changelog.ts"

/** Resolves `CHANGELOG.md` from the app directory, not the bundle directory. */
export function createChangelogSourceFromDisk(appDir: string): ChangelogSource {
	return createChangelogSource({
		readFile: (p: string) => fs.readFileSync(p, "utf8"),
		changelogPath: path.join(appDir, "CHANGELOG.md"),
		async fetchText(url: string, timeoutMs: number) {
			try {
				const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
				if (!res.ok) return null
				return await res.text()
			} catch {
				// Offline or slow upstream: the dashboard shows the local changelog only.
				return null
			}
		},
	})
}
