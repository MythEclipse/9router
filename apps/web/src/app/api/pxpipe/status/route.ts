import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function GET() {
	try {
		return NextResponse.json(await getUseCases().pxpipe.status())
	} catch (error) {
		console.error("[API] Failed to read pxpipe status:", error)
		return NextResponse.json({ error: "Failed to read pxpipe status" }, { status: 500 })
	}
}
