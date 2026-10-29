import { NextResponse } from "next/server"
import { claudeSettingsPort, isClaudeInstalled } from "@/lib/claudeToolHost"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** Claude Code is configured through an `env` block, not a provider entry; see the port. */
export async function GET() {
	const answer = await getUseCases().claudeTools.readSettingsStatus(
		claudeSettingsPort,
		isClaudeInstalled,
	)
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
	}
	const { exaMcpEnabled } = (body ?? {}) as { exaMcpEnabled?: boolean }
	const answer = await getUseCases().claudeTools.writeSettings(body, claudeSettingsPort, {
		exaMcpEnabled: exaMcpEnabled === true,
	})
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function DELETE() {
	const answer = await getUseCases().claudeTools.resetSettings(claudeSettingsPort)
	return NextResponse.json(answer.body, { status: answer.status })
}
