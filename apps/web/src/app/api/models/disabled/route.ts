import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/models/disabled?providerAlias=xxx
export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const result = await getUseCases().disabledModels.list(searchParams.get("providerAlias"))
		return NextResponse.json(result)
	} catch (error) {
		return failed(error, "Failed to fetch disabled models", "Error fetching disabled models")
	}
}

// POST /api/models/disabled  body: { providerAlias, ids: [...] }
export async function POST(request) {
	try {
		const result = await getUseCases().disabledModels.disable(await request.json())
		return NextResponse.json(result)
	} catch (error) {
		// A body that is not JSON used to be a 500 here; it is the caller's error.
		if (error instanceof SyntaxError) {
			return NextResponse.json({ error: "providerAlias and ids[] required" }, { status: 400 })
		}
		return failed(error, "Failed to disable models", "Error disabling models")
	}
}

// DELETE /api/models/disabled?providerAlias=xxx[&id=yyy]
// Without `id` this re-enables every model for the provider, which is the
// documented meaning of an empty list rather than a no-op.
export async function DELETE(request) {
	try {
		const { searchParams } = new URL(request.url)
		const result = await getUseCases().disabledModels.enable({
			providerAlias: searchParams.get("providerAlias"),
			id: searchParams.get("id"),
		})
		return NextResponse.json(result)
	} catch (error) {
		return failed(error, "Failed to enable models", "Error enabling models")
	}
}
