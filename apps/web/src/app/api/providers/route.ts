import { NextResponse } from "next/server"
import { isNameConflict, nameConflictBody } from "@/lib/providerConflicts"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/providers - every connection, secrets stripped, compatible ones named
// after their node. A failed node read only costs the names, not the listing.
export async function GET() {
	try {
		return NextResponse.json({ connections: await getUseCases().connections.list() })
	} catch (error) {
		console.log("Error fetching providers:", error)
		return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 })
	}
}

// POST /api/providers - create a connection (API key only; OAuth has its own flow).
//
// A POST carrying an id edits that connection; without one, a name collision is
// refused with 409 rather than silently replacing a key.
export async function POST(request) {
	try {
		const connection = await getUseCases().connections.create(await request.json())
		return NextResponse.json({ connection }, { status: 201 })
	} catch (error) {
		if (isNameConflict(error)) {
			return NextResponse.json(nameConflictBody(error), { status: 409 })
		}
		return failed(error, "Failed to create provider", "Error creating provider")
	}
}
