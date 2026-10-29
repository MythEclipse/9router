/**
 * The changelog endpoint reads a markdown file from disk, and the file is not where the code expects
 * it to be once the app ships.
 *
 * - **The local file is missing in the standalone build.** `readLocalChangelog` resolves
 *   `process.cwd()/CHANGELOG.md`; in the assembled standalone tree that path does not exist, because
 *   the standalone assembly copies `src/`, `scripts/`, migrations and `public/` but never the
 *   repository's changelog. The route catches the `ENOENT` and falls back to upstream — so the
 *   dashboard silently stops showing *this build's* changelog while looking like it works.
 * - **\`process.cwd()\` is the wrong anchor either way.** It is the directory the server was started
 *   from, which for the systemd unit is whatever `WorkingDirectory` says and for `bun cli` is the
 *   user's shell. A file that ships with the app should be resolved from the app.
 * - **Nothing here is an error.** A missing local file and an unreachable upstream both mean "no
 *   changelog to show", and the dashboard renders a placeholder. Turning either into a 500 would
 *   make a cosmetic feature look like an outage.
 *
 * The verdicts are named here so the route does not have to be read to know them.
 */

/** Where the local changelog is looked for, relative to the app's root. */
export const LOCAL_CHANGELOG_FILENAME = "CHANGELOG.md"

/** Upstream changelog, used when the local copy is absent or empty. */
export const OFFICIAL_CHANGELOG_URL =
	"https://raw.githubusercontent.com/decolua/9router/refs/heads/master/CHANGELOG.md"

/** How long upstream gets before the dashboard gives up and shows what it has. */
export const OFFICIAL_CHANGELOG_TIMEOUT_MS = 6000

/**
 * Whether a changelog body is worth showing.
 *
 * A file that exists but holds only whitespace is the same as no file: the dashboard would render
 * an empty pane with a heading. Both callers check this before using the text.
 */
export function changelogIsUsable(text: string | null | undefined): text is string {
	return typeof text === "string" && text.trim().length > 0
}

/**
 * Which source answered.
 *
 * Kept as two independent flags rather than one winner, because the modal renders both panes: this
 * build's own notes (`custom`) and the upstream project's (`official`). One being missing does not
 * hide the other.
 */
export interface ChangelogPayload {
	readonly ok: boolean
	readonly official: string | null
	readonly custom: string | null
}

/** Pick what to show, trimming an unusable body to `null` rather than sending whitespace. */
export function changelogPayload(
	local: string | null | undefined,
	official: string | null | undefined,
): ChangelogPayload {
	const custom = changelogIsUsable(local) ? local : null
	const upstream = changelogIsUsable(official) ? official : null
	return { ok: Boolean(custom || upstream), official: upstream, custom }
}
