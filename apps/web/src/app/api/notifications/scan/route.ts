import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { getApiKeys } from "@9router/db/repos/apiKeysRepo"
import {
	clearNotificationByKind,
	clearNotificationsByKind,
	notify,
} from "@9router/db/repos/notificationsRepo"
import {
	planQuotaNotices,
	QUOTA_NOTICE_KIND,
	QUOTA_NOTICE_LINK,
	staleQuotaKeys,
} from "9router-api/domain/notification-scan"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { quotaBody, quotaPressure, quotaTitle } from "@/lib/notifications/quotaPressure"

export const dynamic = "force-dynamic"

/**
 * GET /api/notifications/scan - derive conditions into notifications.
 *
 * A notification is written once per condition (dedupeKey), so this can run on every dashboard
 * load without flooding the feed. Each condition also clears itself when it stops being true, so
 * a resolved problem stops nagging and a relapse is announced again. The dedupe and sweep rules
 * live in `domain/notification-scan.ts`; this does the reads and writes around them.
 */
export async function GET() {
	// The bell button and the header call this. A key session gets nothing to derive from: key
	// names and quota pressure are admin-only facts.
	const cookieStore = await cookies()
	const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
	if (!session || session.role === "apikey") {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
	}

	const created = []
	try {
		await clearNotificationsByKind("update")

		const keys = (await getApiKeys()) || []
		// The pressure is kept per key so the wording can be built without deriving it a second
		// time — across a midnight rollover the second read can disagree with the first.
		const pressureById = new Map()
		const { notices, live } = planQuotaNotices(keys, (key) => {
			const pressure = quotaPressure(key)
			if (pressure) pressureById.set(String(key?.id ?? ""), pressure)
			return pressure
		})

		for (const notice of notices) {
			const key = keys.find((k) => String(k?.id) === notice.keyId)
			const pressure = pressureById.get(notice.keyId)
			await notify({
				kind: QUOTA_NOTICE_KIND,
				severity: notice.severity,
				title: quotaTitle(key, pressure),
				body: quotaBody(pressure),
				link: QUOTA_NOTICE_LINK,
				dedupeKey: notice.dedupeKey,
			})
			created.push(`quota:${notice.keyId}`)
		}

		// Clear every notice this pass did not recreate: recovered, raised, deactivated, or
		// switched to a different budget kind.
		for (const dedupeKey of staleQuotaKeys(keys, live)) {
			await clearNotificationByKind(QUOTA_NOTICE_KIND, dedupeKey)
		}
	} catch (error) {
		// Deriving conditions must never break the dashboard.
		console.warn("[notifications] scan failed:", error?.message || error)
	}

	return Response.json({ created, checkedAt: new Date().toISOString() })
}
