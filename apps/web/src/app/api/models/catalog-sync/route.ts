import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/models/catalog-sync - sync state and what the catalog currently holds.
export async function GET() {
	try {
		return NextResponse.json(await getUseCases().catalogueSync.status())
	} catch (error) {
		return failed(error, "Failed to read sync state", "Catalog sync status failed")
	}
}

// POST /api/models/catalog-sync - run a sync now instead of waiting for the timer.
// A sync already in flight answers 503 with its reason, not a silent success.
export async function POST() {
	try {
		const result = await getUseCases().catalogueSync.runNow()
		return NextResponse.json({ success: true, result })
	} catch (error) {
		return failed(error, "Sync could not start", "Catalog sync failed")
	}
}
