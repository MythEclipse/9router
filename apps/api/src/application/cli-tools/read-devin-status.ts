/**
 * Devin CLI detection.
 *
 * Devin is the one tool in this area with no settings to read or write: the binary keeps its own
 * credentials and the operator runs `devin auth login`. So the whole flow is "is it here, and
 * which version", which is still worth a use-case because the *probing order* is a decision —
 * PATH first, then the known installer paths — and a route that owns it cannot be tested
 * without a machine that either has Devin or does not.
 *
 * The probes arrive as ports so a test can describe each combination: on PATH, only in an
 * installer path, absent, and present but unable to answer `--version`.
 */

/** The installation probe: done by looking, not by asking. */
export interface DevinInstallPort {
	/** True when `devin` resolves on PATH. */
	readonly onPath: () => Promise<boolean>
	/** The known installer paths, in the order to try them. */
	readonly candidates: () => string[]
	/** True when the path exists and is readable. */
	readonly exists: (path: string) => Promise<boolean>
}

/** The version probe: `devin --version`, which may fail even when the binary is found. */
export interface DevinVersionPort {
	/** The first line of `--version`, or null when it could not be run. */
	readonly version: () => Promise<string | null>
}

/** A flat answer, matching the other CLI-tool answers. */
export interface DevinStatusAnswer {
	readonly status: number
	readonly body: Record<string, unknown>
}

const NOT_INSTALLED = {
	installed: false,
	message:
		"Devin CLI is not installed. Install it from https://cli.devin.ai and run `devin auth login`.",
	installUrl: "https://cli.devin.ai",
}

/**
 * Where Devin was found, or null.
 *
 * PATH is checked first because it is the installation the operator's own shell would run —
 * if both exist, the one on PATH is the one `devin` means. The installer paths are tried in the
 * order `devinBinCandidates` returns them, which is the same list the executor resolves against;
 * sharing that order is what makes "the screen says installed" and "the app can run it" agree.
 */
async function locate(port: DevinInstallPort): Promise<string | null> {
	if (await port.onPath()) return "path"
	for (const candidate of port.candidates()) {
		if (await port.exists(candidate)) return candidate
	}
	return null
}

/**
 * Whether Devin is installed, and which version.
 *
 * Not installed is a 200 with an explanation and an install URL, not a 404: the screen renders a
 * panel telling the operator what to do, and a 404 reads as a broken endpoint. A version probe
 * that fails is not an error either — the binary is there, so `version: null` is the honest
 * answer, and the message still tells them to log in.
 */
export async function readDevinStatus(
	install: DevinInstallPort,
	version: DevinVersionPort,
): Promise<DevinStatusAnswer> {
	try {
		const source = await locate(install)
		if (source === null) return { status: 200, body: NOT_INSTALLED }

		return {
			status: 200,
			body: {
				installed: true,
				source,
				version: await version.version(),
				message: "Devin CLI detected. Make sure `devin auth login` has been run.",
			},
		}
	} catch (error) {
		return {
			status: 500,
			body: { error: error instanceof Error ? error.message : "Failed to check devin settings" },
		}
	}
}
