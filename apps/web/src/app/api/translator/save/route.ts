import fs from "node:fs"
import path from "node:path"
import { translatorDumpFile } from "9router-api/domain/translator"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/** Where the inspector writes its pipeline dumps. */
function translatorLogsDir(): string {
	return path.join(process.cwd(), "logs", "translator")
}

/**
 * POST /api/translator/save - write one captured dump.
 *
 * The filename is caller-supplied and lands in `path.join`, so `translatorDumpFile` is the only
 * thing standing between the dashboard and an arbitrary file write. It must stay an exact match.
 */
export async function POST(request) {
	try {
		const { file, content } = await request.json()
		const allowed = translatorDumpFile(file)
		if (allowed === null) {
			return NextResponse.json({ success: false, error: "Invalid file name" }, { status: 400 })
		}
		if (content === undefined) {
			return NextResponse.json({ success: false, error: "Content required" }, { status: 400 })
		}

		const logsDir = translatorLogsDir()
		fs.mkdirSync(logsDir, { recursive: true })
		fs.writeFileSync(path.join(logsDir, allowed), content, "utf-8")

		return NextResponse.json({ success: true })
	} catch (error) {
		console.error("Error saving file:", error)
		return NextResponse.json({ success: false, error: error.message }, { status: 500 })
	}
}
