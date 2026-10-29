import { consoleLogsPayload } from "9router-api/domain/translator"
import { NextResponse } from "next/server"
import { clearConsoleLogs, getConsoleLogs, initConsoleLogCapture } from "@/lib/consoleLogBuffer"

export const dynamic = "force-dynamic"

initConsoleLogCapture()

export async function GET() {
	try {
		return NextResponse.json(consoleLogsPayload(getConsoleLogs()))
	} catch (error) {
		console.error("Error getting console logs:", error)
		return NextResponse.json({ success: false, error: error.message }, { status: 500 })
	}
}

export async function DELETE() {
	try {
		clearConsoleLogs()
		return NextResponse.json({ success: true })
	} catch (error) {
		console.error("Error clearing console logs:", error)
		return NextResponse.json({ success: false, error: error.message }, { status: 500 })
	}
}
