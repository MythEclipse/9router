import { NextResponse } from "next/server"
import {
	isJcodeInstalled,
	jcodeConfigPath,
	jcodeSettingsConfig,
	removeJcodeEnv,
	writeJcodeEnv,
} from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * jcode splits its config in two: the TOML names an env file, and the key lives in that file.
 * Both writes belong to one save, so the env file is a side write rather than a second route.
 */
const deps = () => ({
	isInstalled: isJcodeInstalled,
	config: jcodeSettingsConfig,
	// A side write receives the validated form, not a bare string — it runs after the
	// key has been resolved, so it writes exactly what the config entry names.
	sideWrites: [(input) => writeJcodeEnv(input.apiKey)],
	sideRemovals: [removeJcodeEnv],
	notInstalledMessage:
		"jcode not installed. Install via: curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash",
	appliedMessage: "jcode configured successfully. Use: jcode --provider-profile 9router",
	resetMessage: "9router configuration removed from jcode",
})

export async function GET() {
	const answer = await getUseCases().cliTools.readToolSettingsStatus(deps())
	return NextResponse.json(
		{ ...answer.body, configPath: jcodeConfigPath() },
		{ status: answer.status },
	)
}

export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 })
	}
	const answer = await getUseCases().cliTools.writeToolSettings(body, deps())
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function DELETE() {
	const answer = await getUseCases().cliTools.resetToolSettings(deps())
	return NextResponse.json(answer.body, { status: answer.status })
}
