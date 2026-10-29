import { exec } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import { promisify } from "node:util"
import { devinBinCandidates } from "9router-api/domain/devin-binary"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const execAsync = promisify(exec)

const checkDevinInstalled = async () => {
	// 1. PATH lookup
	try {
		const isWindows = os.platform() === "win32"
		const command = isWindows ? "where devin" : "which devin"
		await execAsync(command, { windowsHide: true })
		return { installed: true, source: "path" }
	} catch {
		// fall through to filesystem probes
	}
	// 2. Known installer paths — the same list the executor resolves against.
	for (const candidate of devinBinCandidates({
		platform: os.platform(),
		home: os.homedir(),
		localAppData: process.env.LOCALAPPDATA,
	})) {
		try {
			await fs.access(candidate)
			return { installed: true, source: candidate }
		} catch {
			/* keep probing */
		}
	}
	return { installed: false, source: null }
}

const readDevinVersion = async () => {
	try {
		const { stdout } = await execAsync("devin --version", { windowsHide: true })
		return stdout.trim().split("\n")[0] || null
	} catch {
		return null
	}
}

// GET - install detection only. No config to write: the binary handles its own auth.
export async function GET() {
	try {
		const { installed, source } = await checkDevinInstalled()
		if (!installed) {
			return NextResponse.json({
				installed: false,
				message:
					"Devin CLI is not installed. Install it from https://cli.devin.ai and run `devin auth login`.",
				installUrl: "https://cli.devin.ai",
			})
		}
		const version = await readDevinVersion()
		return NextResponse.json({
			installed: true,
			source,
			version,
			message: "Devin CLI detected. Make sure `devin auth login` has been run.",
		})
	} catch (error) {
		console.log("Error checking devin settings:", error)
		return NextResponse.json({ error: "Failed to check devin settings" }, { status: 500 })
	}
}
