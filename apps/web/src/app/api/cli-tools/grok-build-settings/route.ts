import { NextResponse } from "next/server"
import {
	grokBuildSettingsConfig,
	isGrokBuildInstalled,
	removeGrokBuildSettings,
} from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** Grok Build's `[models]` slots are edited by `domain/grok-build-config.ts`; see the host. */
const deps = () => ({
	isInstalled: isGrokBuildInstalled,
	config: grokBuildSettingsConfig,
	sideRemovals: [removeGrokBuildSettings],
	notInstalledMessage: "Grok Build CLI is not installed",
	appliedMessage: "Grok Build settings applied successfully!",
	resetMessage: "9router model slots removed from Grok Build",
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
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
	}
	const answer = await getUseCases().cliTools.writeToolSettings(body, deps())
	return NextResponse.json(
		{ ...answer.body, ...(answer.ok ? { modelSlot: "9router" } : {}) },
		{ status: answer.status },
	)
}

export async function DELETE() {
	const answer = await getUseCases().cliTools.resetToolSettings(deps())
	return NextResponse.json(answer.body, { status: answer.status })
}
