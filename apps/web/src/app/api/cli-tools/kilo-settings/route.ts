import { NextResponse } from "next/server"
import { isKiloInstalled, kiloSettingsConfig, writeKiloVsCodeSettings } from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** Kilo Code keeps its config under one file per tool; see `cliToolHosts`. */
const deps = () => ({
	isInstalled: isKiloInstalled,
	config: kiloSettingsConfig,
	sideWrites: [
		(input: { baseUrl: string; apiKey: string; model: string }) => writeKiloVsCodeSettings(input),
	],
	sideRemovals: [() => writeKiloVsCodeSettings({ baseUrl: "", apiKey: "", model: "" }, true)],
	notInstalledMessage: "Kilo Code CLI is not installed",
	appliedMessage: "Kilo Code settings applied successfully!",
	resetMessage: "9Router settings removed from Kilo Code",
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
