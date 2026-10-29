import fs from "node:fs"
import path from "node:path"
import { translatorDumpFile } from "9router-api/domain/translator"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/** Where the inspector writes its pipeline dumps. */
function translatorLogsDir(): string {
	return path.join(process.cwd(), "logs", "translator")
}

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const file = translatorDumpFile(searchParams.get("file"))
		if (file === null) {
			return NextResponse.json({ success: false, error: "Invalid file name" }, { status: 400 })
		}

		const filePath = path.join(translatorLogsDir(), file)
		if (!fs.existsSync(filePath)) {
			return NextResponse.json({ success: false, error: "File not found" }, { status: 404 })
		}

		return NextResponse.json({ success: true, content: fs.readFileSync(filePath, "utf-8") })
	} catch (error) {
		console.error("Error loading file:", error)
		return NextResponse.json({ success: false, error: error.message }, { status: 500 })
	}
}
