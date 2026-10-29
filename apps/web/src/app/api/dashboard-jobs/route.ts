import { NextResponse } from "next/server"
// Importing this module registers the operation handlers, before any request can
// ask about a kind.
import "@/lib/db/dashboardJobHandlers"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// POST /api/dashboard-jobs - start a server-side dashboard operation.
//
// The operation runs on the server and survives the browser closing; the
// dashboard polls for progress and can leave.
export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
	}

	try {
		const { jobId, pollMs } = await getUseCases().dashboardJobs.start(body)
		return NextResponse.json({ jobId, pollMs }, { status: 202 })
	} catch (error) {
		// An unknown kind or a malformed payload is the caller's fault; anything
		// else is ours, and reporting it as 400 is what the old catch-all did.
		if (isAppError(error, "VALIDATION")) {
			return NextResponse.json({ error: error.message }, { status: 400 })
		}
		console.error("[API] Failed to start the operation:", error)
		return NextResponse.json({ error: "Could not start the operation" }, { status: 500 })
	}
}

// GET /api/dashboard-jobs?id=... - one job's progress.
// GET /api/dashboard-jobs (no id) - every live job, for the notification bell.
export async function GET(request: Request) {
	const id = new URL(request.url).searchParams.get("id")

	try {
		const jobs = getUseCases().dashboardJobs
		if (id) {
			const { job } = await jobs.read(id)
			return NextResponse.json({ job })
		}
		const live = await jobs.live()
		return NextResponse.json({ jobs: live.jobs, pollMs: live.pollMs })
	} catch (error) {
		if (isAppError(error, "NOT_FOUND")) {
			return NextResponse.json({ error: error.message }, { status: 404 })
		}
		console.error("[API] Failed to read the operation:", error)
		return NextResponse.json({ error: "Could not read the operation" }, { status: 500 })
	}
}

// DELETE /api/dashboard-jobs?id=... - stop a running job.
export async function DELETE(request: Request) {
	const id = new URL(request.url).searchParams.get("id")
	if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })

	try {
		await getUseCases().dashboardJobs.cancel(id)
		return NextResponse.json({ ok: true })
	} catch (error) {
		if (isAppError(error, "NOT_FOUND")) {
			return NextResponse.json({ error: error.message }, { status: 404 })
		}
		console.error("[API] Failed to cancel the operation:", error)
		return NextResponse.json({ error: "Could not cancel the operation" }, { status: 500 })
	}
}

function isAppError(error: unknown, code: string): error is { message: string } {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === code
	)
}
