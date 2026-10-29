import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * DELETE /api/proxy-pools/bulk — { ids } or { all: true }.
 *
 * One statement, one transaction, one auth check. The page used to issue a DELETE per id
 * in a loop: hundreds of round trips for a few hundred pools, and not cancellable halfway
 * without leaving a partial delete.
 */
export async function DELETE(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		return NextResponse.json(await getUseCases().proxyPools.bulkRemove(body))
	} catch (error) {
		console.log("Error bulk deleting proxy pools:", error)
		return failed(error, "Failed to delete proxy pools", "Error bulk deleting proxy pools")
	}
}
