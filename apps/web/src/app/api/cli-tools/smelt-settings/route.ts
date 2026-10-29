import { NextResponse } from "next/server"
import { isSmeltInstalled, smeltSettingsConfig } from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** Smelt keeps one flat file; see `smeltSettingsConfig` for the keys it owns. */
const deps = () => ({
	isInstalled: isSmeltInstalled,
	config: smeltSettingsConfig,
	notInstalledMessage: "Smelt CLI is not installed",
	appliedMessage: "Smelt settings applied successfully!",
	resetMessage: "Smelt 9Router settings removed",
})

export async function GET() {
	const answer = await getUseCases().cliTools.readToolSettingsStatus(deps())
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function POST(request: Request) {
	const answer = await getUseCases().cliTools.writeToolSettings(await bodyOf(request), deps())
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function DELETE() {
	const answer = await getUseCases().cliTools.resetToolSettings(deps())
	return NextResponse.json(answer.body, { status: answer.status })
}

/** Smelt's screen sends a body it expects to be JSON; a malformed one is a 400, not a crash. */
async function bodyOf(request: Request): Promise<unknown> {
	try {
		return await request.json()
	} catch {
		return null
	}
}
