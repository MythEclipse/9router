/**
 * Custom models the operator added.
 *
 * Delegates: capability keys and the STT transport are filtered by a domain rule, so a
 * client cannot store a string where a boolean belongs — that rule lives in
 * `9router-api`, not here. The guard denies this path by default, so the session
 * travels with the call.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: new Headers(),
	})
}

/** Every custom model the operator added. */
export async function GET() {
	try {
		return NextResponse.json(await (await client()).models.custom.list())
	} catch (error) {
		return failed(error, "Failed to fetch custom models", "Error fetching custom models")
	}
}

export async function POST(request: Request) {
	try {
		const body = await request.json().catch(() => undefined)
		const { added } = await (await client()).models.custom.add(body)
		return NextResponse.json({ success: true, added })
	} catch (error) {
		return failed(error, "Failed to add custom model", "Error adding custom model")
	}
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
export async function DELETE(request) {
	try {
		const { searchParams } = new URL(request.url)
		const providerAlias = searchParams.get("providerAlias") ?? ""
		const id = searchParams.get("id") ?? ""
		if (!providerAlias || !id) {
			return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 })
		}
		const result = await getUseCases().customModels.remove({
			providerAlias,
			id,
			type: searchParams.get("type") || "llm",
		})
		return NextResponse.json({
			success: true,
			...(result.keysLeftForReview.length ? { keysLeftForReview: result.keysLeftForReview } : {}),
		})
	} catch (error) {
		return failed(error, "Failed to delete custom model", "Error deleting custom model")
	}
}
