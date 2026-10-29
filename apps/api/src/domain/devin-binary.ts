/**
 * Where the Devin CLI may be installed, in the order a lookup should try.
 *
 * Two callers depend on this list: the executor that spawns `devin`, and the settings screen that
 * reports whether it is installed. They used to keep separate copies, which is exactly the drift
 * that makes a screen say "not installed" while the gateway spawns it fine — the executor probes
 * `~/.local/share/devin/bin`, the screen did not, and the operator had no way to tell which one was
 * lying. One list, both callers.
 */

/** The candidates for a platform, most specific first. */
export function devinBinCandidates(options: {
	platform: NodeJS.Platform
	home: string
	localAppData?: string
}): string[] {
	const join = (...parts: string[]) => parts.join("/")
	const localAppData = options.localAppData || join(options.home, "AppData", "Local")

	if (options.platform === "win32") {
		// The official installer writes into LOCALAPPDATA; the rest are package managers.
		return [
			join(localAppData, "devin", "cli", "bin", "devin.exe"),
			join(options.home, ".local", "bin", "devin.exe"),
			join(options.home, "scoop", "shims", "devin.exe"),
			join(localAppData, "Programs", "devin", "devin.exe"),
		]
	}

	// `spawn` runs with `shell: false` on macOS and Linux, so a server started by launchd or a
	// tray process has no login PATH. These paths are probed explicitly for that reason.
	return [
		join(options.home, ".local", "share", "devin", "bin", "devin"),
		join(options.home, ".devin", "bin", "devin"),
		join(options.home, ".local", "bin", "devin"),
		"/opt/homebrew/bin/devin",
		"/usr/local/bin/devin",
		"/usr/bin/devin",
	]
}

/**
 * The explicit override, when the operator set one.
 *
 * Checked before the candidate list because `CLI_DEVIN_BIN` exists precisely for the case the
 * candidates miss; probing a stale default first would ignore the instruction.
 */
export function devinBinOverride(env: Record<string, string | undefined>): string | null {
	const override = env.CLI_DEVIN_BIN?.trim()
	return override ? override : null
}
