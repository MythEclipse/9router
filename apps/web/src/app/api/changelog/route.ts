import fs from "node:fs"
import path from "node:path"
import {
	changelogPayload,
	LOCAL_CHANGELOG_FILENAME,
	OFFICIAL_CHANGELOG_TIMEOUT_MS,
	OFFICIAL_CHANGELOG_URL,
} from "9router-api/domain/changelog-source"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

// This repo's own CHANGELOG.md is served locally; the official upstream changelog comes from GitHub.
function readLocalChangelog() {
	try {
		return fs.readFileSync(path.join(process.cwd(), LOCAL_CHANGELOG_FILENAME), "utf8")
	} catch {
		// Missing in bundled/standalone runtimes - not an error, the caller falls back.
		return null
	}
}

async function fetchOfficialChangelog() {
	try {
		const res = await fetch(OFFICIAL_CHANGELOG_URL, {
			cache: "no-store",
			signal: AbortSignal.timeout(OFFICIAL_CHANGELOG_TIMEOUT_MS),
		})
		if (!res.ok) return null
		return await res.text()
	} catch {
		return null
	}
}

// GET /api/changelog - { official, custom } markdown, served from disk so the modal works offline.
export async function GET() {
	const custom = readLocalChangelog()
	const official = await fetchOfficialChangelog()

	return NextResponse.json(changelogPayload(custom, official))
}
