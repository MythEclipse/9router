import { execSync } from "node:child_process"
import {
	isMitmFailure,
	type MitmPlatform,
	mitmHasPrivilege,
	mitmPrivilegeRefusal,
	normaliseMitmRouterBaseUrl,
	presentMitmStatus,
	readMitmStartRequest,
	readMitmToolToggle,
	resolveMitmPassword,
} from "9router-api/domain/mitm-panel"
import { NextResponse } from "next/server"
import { getSettings, updateSettings } from "@/lib/localDb"
import {
	disableToolDNS,
	enableToolDNS,
	getCachedPassword,
	getMitmStatus,
	initDbHooks,
	isSudoPasswordRequired,
	loadEncryptedPassword,
	setCachedPassword,
	startServer,
	stopServer,
	trustCert,
} from "@/mitm/manager"

export const dynamic = "force-dynamic"

initDbHooks(getSettings, updateSettings)

const isWin = process.platform === "win32"

/**
 * Whether this process can already write the hosts file without help.
 *
 * The elevated check on Windows is a probe, not a property, so it runs here where the shell is
 * available; the domain only ever sees the resulting level.
 */
function detectPrivilege(): MitmPlatform["privilege"] {
	if (isWin) {
		try {
			execSync("net session >nul 2>&1", { windowsHide: true })
			return "windows-admin"
		} catch {
			return "user"
		}
	}
	return typeof process.getuid === "function" && process.getuid() === 0 ? "root" : "user"
}

function platform(): MitmPlatform {
	return {
		isWindows: isWin,
		privilege: detectPrivilege(),
		sudoPasswordRequired: isSudoPasswordRequired(),
	}
}

/** The password this request will use, resolved from request → cache → encrypted store. */
async function passwordFor(provided: string | undefined): Promise<string> {
	return resolveMitmPassword({
		provided,
		cached: getCachedPassword(),
		stored: await loadEncryptedPassword(),
	})
}

async function hasAnyPassword(): Promise<boolean> {
	return !!getCachedPassword() || !!(await loadEncryptedPassword())
}

// GET - Full MITM status (server + per-tool DNS)
export async function GET() {
	try {
		const settings = await getSettings()
		return NextResponse.json(
			presentMitmStatus({
				platform: platform(),
				status: await getMitmStatus(),
				hasCachedPassword: await hasAnyPassword(),
				storedRouterBaseUrl: settings.mitmRouterBaseUrl,
			}),
		)
	} catch (error) {
		console.log("Error getting MITM status:", error.message)
		return NextResponse.json({ error: "Failed to get MITM status" }, { status: 500 })
	}
}

// POST - Start MITM server (cert + server, no DNS)
export async function POST(request) {
	try {
		const parsed = readMitmStartRequest(await request.json())
		if (isMitmFailure(parsed)) {
			return NextResponse.json({ error: parsed.error }, { status: parsed.status })
		}
		const { apiKey, sudoPassword, mitmRouterBaseUrl, forceKillPort443 } = parsed.value
		const host = platform()
		const pwd = await passwordFor(sudoPassword)

		if (!mitmHasPrivilege(host, pwd)) {
			return NextResponse.json({ error: mitmPrivilegeRefusal(host, "start MITM") }, { status: 403 })
		}

		if (mitmRouterBaseUrl !== undefined && mitmRouterBaseUrl !== null) {
			const normalised = normaliseMitmRouterBaseUrl(mitmRouterBaseUrl)
			if (isMitmFailure(normalised)) {
				return NextResponse.json({ error: normalised.error }, { status: normalised.status })
			}
			await updateSettings({ mitmRouterBaseUrl: normalised.value })
		}

		const result = await startServer(apiKey, pwd, forceKillPort443)
		if (!isWin) setCachedPassword(pwd)

		return NextResponse.json({ success: true, running: result.running, pid: result.pid })
	} catch (error) {
		console.log("Error starting MITM server:", error.message)
		if (error.code === "PORT_443_BUSY") {
			return NextResponse.json(
				{ error: error.message, code: "PORT_443_BUSY", portOwner: error.portOwner },
				{ status: 409 },
			)
		}
		return NextResponse.json(
			{ error: error.message || "Failed to start MITM server" },
			{ status: 500 },
		)
	}
}

// DELETE - Stop MITM server (removes all DNS first, then kills server)
export async function DELETE(request) {
	try {
		const body = await request.json().catch(() => ({}))
		const provided = typeof body?.sudoPassword === "string" ? body.sudoPassword : undefined
		const host = platform()
		const pwd = await passwordFor(provided)

		if (!mitmHasPrivilege(host, pwd)) {
			return NextResponse.json({ error: mitmPrivilegeRefusal(host, "stop MITM") }, { status: 403 })
		}

		await stopServer(pwd)
		if (!isWin && provided) setCachedPassword(provided)

		return NextResponse.json({ success: true, running: false })
	} catch (error) {
		console.log("Error stopping MITM server:", error.message)
		return NextResponse.json(
			{ error: error.message || "Failed to stop MITM server" },
			{ status: 500 },
		)
	}
}

// PATCH - Toggle DNS for a specific tool (enable/disable) or trust the certificate
export async function PATCH(request) {
	try {
		const parsed = readMitmToolToggle(await request.json())
		if (isMitmFailure(parsed)) {
			return NextResponse.json({ error: parsed.error }, { status: parsed.status })
		}
		const { tool, action, sudoPassword } = parsed.value
		const host = platform()
		const pwd = await passwordFor(sudoPassword)

		if (!mitmHasPrivilege(host, pwd)) {
			return NextResponse.json({ error: mitmPrivilegeRefusal(host, "modify DNS") }, { status: 403 })
		}

		if (action === "enable") {
			await enableToolDNS(tool, pwd)
		} else if (action === "disable") {
			await disableToolDNS(tool, pwd)
		} else {
			await trustCert(pwd)
			if (!isWin && sudoPassword) setCachedPassword(sudoPassword)
			const status = await getMitmStatus()
			return NextResponse.json({ success: true, certTrusted: status.certTrusted })
		}

		if (!isWin && sudoPassword) setCachedPassword(sudoPassword)

		const status = await getMitmStatus()
		return NextResponse.json({ success: true, dnsStatus: status.dnsStatus })
	} catch (error) {
		console.log("Error toggling DNS:", error.message)
		return NextResponse.json({ error: error.message || "Failed to toggle DNS" }, { status: 500 })
	}
}
