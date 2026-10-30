/**
 * The translator inspector's dump files.
 *
 * The dashboard can ask for a capture by name and write one back, so both directions take a
 * caller-supplied filename into a directory path. `translatorDumpFile` is the only thing between
 * that and an arbitrary read or write — it must stay an exact, closed match, and it is applied
 * before the filesystem is touched at all, on both verbs.
 *
 * The filesystem is a port rather than an import: this use-case must be testable without a real
 * `logs/translator` folder, and the traversal rule must be provable without one too.
 */

/** The dump store. The host decides where `logs/translator` actually is. */
export interface TranslatorDumpStore {
	/** The content, or `null` when the file is not there. */
	readonly read: (file: string) => string | null
	readonly write: (file: string, content: string) => void
}

export interface DumpAnswer {
	readonly status: number
	readonly body: Record<string, unknown>
}

/** The name rule, injected so this module does not reach into the domain's own imports. */
export type DumpNameRule = (raw: unknown) => string | null

const invalidName = (): DumpAnswer => ({
	status: 400,
	body: { success: false, error: "Invalid file name" },
})

const failure = (error: unknown, fallback: string): DumpAnswer => ({
	status: 500,
	body: { success: false, error: (error as { message?: string })?.message ?? fallback },
})

/**
 * One capture.
 *
 * A refused name is a 400 and a missing file a 404 — the dashboard tells them apart, and a
 * traversal attempt must not be reported as "not found", which would read like an ordinary typo.
 */
export async function loadDump(
	rawFile: unknown,
	safeName: DumpNameRule,
	store: TranslatorDumpStore,
): Promise<DumpAnswer> {
	const file = safeName(rawFile)
	if (file === null) return invalidName()
	try {
		const content = store.read(file)
		if (content === null) {
			return { status: 404, body: { success: false, error: "File not found" } }
		}
		return { status: 200, body: { success: true, content } }
	} catch (error) {
		return failure(error, "Failed to load file")
	}
}

/**
 * Write one capture.
 *
 * The same closed name rule runs first, so a refused name never reaches `mkdir`. Undefined content
 * is a 400 rather than a write of the string `"undefined"`.
 */
export async function saveDump(
	body: unknown,
	safeName: DumpNameRule,
	store: TranslatorDumpStore,
): Promise<DumpAnswer> {
	const { file, content } = (body ?? {}) as { file?: unknown; content?: unknown }
	const allowed = safeName(file)
	if (allowed === null) return invalidName()
	if (content === undefined) {
		return { status: 400, body: { success: false, error: "Content required" } }
	}
	try {
		store.write(allowed, String(content))
		return { status: 200, body: { success: true } }
	} catch (error) {
		return failure(error, "Failed to save file")
	}
}
