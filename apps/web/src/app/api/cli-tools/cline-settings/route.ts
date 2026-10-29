import { NextResponse } from "next/server"
import {
	clineSettingsConfig,
	isClineInstalled,
	removeClineSettings,
	writeClineSecret,
} from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * Cline splits its state in two: the provider choice in `globalState.json`, the key in
 * `secrets.json`. Cline wants the base URL without `/v1` — see `clineSettingsConfig`.
 */
const deps = () => ({
	isInstalled: isClineInstalled,
	config: clineSettingsConfig,
	sideWrites: [(input: { apiKey: string }) => writeClineSecret(input.apiKey)],
	sideRemovals: [removeClineSettings],
	notInstalledMessage: "Cline CLI is not installed",
	appliedMessage: "Cline settings applied successfully!",
	resetMessage: "9Router settings removed from Cline",
})

export async function GET() {
	const answer = await getUseCases().cliTools.readToolSettingsStatus(deps())
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
	}
	const answer = await getUseCases().cliTools.writeToolSettings(body, deps())
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function DELETE() {
	const answer = await getUseCases().cliTools.resetToolSettings(deps())
	return NextResponse.json(answer.body, { status: answer.status })
}
