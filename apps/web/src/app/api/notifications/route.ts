import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import {
	clearNotificationById,
	clearNotificationByKind,
	getUnreadCount,
	listNotifications,
	markRead,
} from "@9router/db/repos/notificationsRepo"
import {
	canReadNotifications,
	notificationCommand,
	notificationLimit,
} from "9router-api/domain/notification-feed"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/**
 * GET /api/notifications - the bell feed.
 * POST /api/notifications - { action: "read", id }, or { action: "clear", id } for one dismissed
 * row / { action: "clear", kind, dedupeKey } for a resolved condition.
 *
 * Closed to key sessions: these messages name quota pressure and failed attempts against this
 * install, which is administrator information. The shape rules live in
 * `domain/notification-feed.ts`.
 */
async function hasFeedAccess() {
	const cookieStore = await cookies()
	const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
	return canReadNotifications(session)
}

export async function GET(request) {
	try {
		if (!(await hasFeedAccess())) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
		}

		const { searchParams } = new URL(request.url)
		const data = await listNotifications({ limit: notificationLimit(searchParams.get("limit")) })
		return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } })
	} catch (error) {
		console.log("Error listing notifications:", error)
		return NextResponse.json({ error: "Failed to load notifications" }, { status: 500 })
	}
}

export async function POST(request) {
	try {
		if (!(await hasFeedAccess())) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
		}

		const command = notificationCommand(await request.json().catch(() => ({})))

		if (command.action === "read") {
			await markRead(command.id ?? "all")
			return NextResponse.json({ ok: true, unread: await getUnreadCount() })
		}

		if (command.action === "clear-row") {
			await clearNotificationById(command.id)
			return NextResponse.json({ ok: true, unread: await getUnreadCount() })
		}

		if (command.action === "clear-condition") {
			await clearNotificationByKind(command.kind, command.dedupeKey)
			return NextResponse.json({ ok: true, unread: await getUnreadCount() })
		}

		return NextResponse.json({ error: "Unknown action" }, { status: 400 })
	} catch (error) {
		console.log("Error updating notifications:", error)
		return NextResponse.json({ error: "Failed to update notifications" }, { status: 500 })
	}
}
