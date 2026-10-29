import { aliasWriteRefusal, sanitizeAliasMappings } from "9router-api/domain/mitm-alias"
import { NextResponse } from "next/server"
import { writeAliasForTool } from "@/lib/mitmAliasCache"
import { getMitmStatus } from "@/mitm/manager"
import { getMitmAlias, setMitmAliasAll } from "@/models"

export const dynamic = "force-dynamic"

// GET - Get MITM aliases for a tool
export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const toolName = searchParams.get("tool")
		const aliases = await getMitmAlias(toolName || undefined)
		return NextResponse.json({ aliases })
	} catch (error) {
		console.log("Error fetching MITM aliases:", error.message)
		return NextResponse.json({ error: "Failed to fetch aliases" }, { status: 500 })
	}
}

// PUT - Save MITM aliases for a specific tool
export async function PUT(request) {
	try {
		const { tool, mappings } = await request.json()

		const status = await getMitmStatus()
		const refusal = aliasWriteRefusal(tool, mappings, status.dnsStatus)
		if (refusal) {
			return NextResponse.json({ error: refusal.error }, { status: refusal.status })
		}

		const filtered = sanitizeAliasMappings(mappings)

		await setMitmAliasAll(tool, filtered)
		writeAliasForTool(tool, filtered)
		return NextResponse.json({ success: true, aliases: filtered })
	} catch (error) {
		console.log("Error saving MITM aliases:", error.message)
		return NextResponse.json({ error: "Failed to save aliases" }, { status: 500 })
	}
}
