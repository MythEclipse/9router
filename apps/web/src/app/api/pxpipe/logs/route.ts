import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
	try {
		const limit = new URL(request.url).searchParams.get("limit")
		return NextResponse.json(await getUseCases().pxpipe.logs(limit))
	} catch (error) {
		console.error("[API] Failed to read pxpipe logs:", error)
		return NextResponse.json({ error: "Failed to read pxpipe logs" }, { status: 500 })
	}
}
