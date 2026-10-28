/**
 * Changelog port.
 *
 * The dashboard shows two changelogs: this repo's own `CHANGELOG.md` and the
 * upstream one from GitHub. Both are best-effort — a bundled runtime has no
 * `CHANGELOG.md` on disk and an offline install cannot reach GitHub, and in
 * neither case is that an error worth failing the modal over.
 *
 * The use-case owns the fallback policy; this adapter only knows how to read a
 * file and fetch a URL.
 */
export const OFFICIAL_CHANGELOG_URL =
	"https://raw.githubusercontent.com/decolua/9router/refs/heads/master/CHANGELOG.md"

export interface ChangelogSource {
	readLocal(): string | null
	fetchOfficial(): Promise<string | null>
}

/** Empty and whitespace-only files are treated as absent, not as an empty body. */
function nonBlank(text: string | null): string | null {
	if (text === null) return null
	return text.trim() ? text : null
}

export function createChangelogSource(deps: {
	readFile: (path: string) => string
	changelogPath: string
	fetchText: (url: string, timeoutMs: number) => Promise<string | null>
}): ChangelogSource {
	return {
		readLocal() {
			try {
				return nonBlank(deps.readFile(deps.changelogPath))
			} catch {
				// Absent in bundled/standalone runtimes; the caller falls back.
				return null
			}
		},
		async fetchOfficial() {
			return nonBlank(await deps.fetchText(OFFICIAL_CHANGELOG_URL, 6000))
		},
	}
}

export interface Changelog {
	readonly ok: boolean
	readonly official: string | null
	readonly custom: string | null
}

/**
 * Both sources are fetched concurrently: the GitHub request dominates latency
 * and the local read is synchronous, so serialising them gains nothing.
 */
export async function loadChangelog(source: ChangelogSource): Promise<Changelog> {
	const custom = source.readLocal()
	const official = await source.fetchOfficial()
	return { ok: Boolean(official || custom), official, custom }
}
