import { NextResponse } from "next/server"
import {
	isOmpInstalled,
	ompSettingsConfig,
	removeOmpSettings,
	writeOmpCredentials,
} from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** OMP keeps `models.yml` and mirrors the key into `agent.db`; see the host. */
const deps = () => ({
	isInstalled: isOmpInstalled,
	config: ompSettingsConfig,
	sideWrites: [writeOmpCredentials],
	sideRemovals: [removeOmpSettings],
	notInstalledMessage: "Oh My Pi is not installed",
	appliedMessage: "Oh My Pi settings applied! Run 'omp' and 9Router models appear under 9router.",
	resetMessage: "9Router removed from Oh My Pi",
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
		return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 })
	}
	const answer = await getUseCases().cliTools.writeToolSettings(body, deps())
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function DELETE() {
	const answer = await getUseCases().cliTools.resetToolSettings(deps())
	return NextResponse.json(answer.body, { status: answer.status })
}
