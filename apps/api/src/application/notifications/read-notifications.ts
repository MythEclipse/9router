/**
 * The notification bell: the feed, and the three ways to clear one.
 *
 * Two rules live here rather than in the route, because both are easy to get subtly wrong and
 * neither is about HTTP:
 *
 * - **Access is decided before anything is read.** The feed names quota pressure and failed
 *   attempts against this install, so an unauthorised caller must not even learn how many rows
 *   exist. The check is `canReadNotifications`, the domain's own rule, and it runs first.
 * - **Every mutating answer carries the new unread count.** The bell is polled, not pushed: an
 *   answer that only said `ok` would leave the badge stale until the next refresh, and three
 *   callers each computing the count their own way is how the badge and the list disagree.
 */
import {
	canReadNotifications,
	notificationCommand,
	notificationLimit,
} from "../../domain/notification-feed.ts"

/** The repo this flow reads and writes through. The host supplies it; nothing else does. */
export interface NotificationStore {
	readonly list: (input: { limit?: number }) => Promise<unknown>
	readonly unreadCount: () => Promise<number>
	/**
	 * Writes answer an acknowledgement rather than nothing. The use-case ignores it on purpose —
	 * what the caller is told is the recount, not the repo's own receipt — but the port has to
	 * state the repo's real shape or the adapter has to lie about it.
	 */
	readonly markRead: (id: string) => Promise<unknown>
	readonly clearById: (id: string) => Promise<unknown>
	readonly clearByKind: (kind: string, dedupeKey: string) => Promise<unknown>
}

export interface NotificationAnswer {
	readonly status: number
	readonly body: Record<string, unknown>
	/** The feed is polled for changes, so a cache would show yesterday's quota pressure. */
	readonly headers?: Record<string, string>
}

const unauthorized = (): NotificationAnswer => ({
	status: 401,
	body: { error: "Unauthorized" },
})

const failed = (error: unknown, message: string): NotificationAnswer => ({
	status: 500,
	body: { error: message },
})

/**
 * One page of the feed.
 *
 * `limit` arrives as a query string, so the domain decides only whether it is a usable number;
 * the repo clamps it to its own ceiling (200). The division matters: the domain must not encode a
 * table's page size, and the repo must not trust a caller. The first draft of this comment claimed
 * the clamp happened here, which was not true — the test that caught it now asserts the truth.
 */
export async function readNotifications(
	session: unknown,
	limit: unknown,
	store: NotificationStore,
): Promise<NotificationAnswer> {
	if (!canReadNotifications(session)) return unauthorized()
	try {
		const data = await store.list({ limit: notificationLimit(limit) })
		return {
			status: 200,
			body: data as Record<string, unknown>,
			headers: { "Cache-Control": "no-store" },
		}
	} catch (error) {
		return failed(error, "Failed to load notifications")
	}
}

/**
 * Mark one row, dismiss one row, or clear one resolved condition.
 *
 * An unknown action is a 400 rather than a silent success: the caller sent something this
 * endpoint does not do, and answering 200 would tell the dashboard it worked.
 */
export async function updateNotification(
	session: unknown,
	body: unknown,
	store: NotificationStore,
): Promise<NotificationAnswer> {
	if (!canReadNotifications(session)) return unauthorized()
	try {
		const command = notificationCommand(body)

		if (command.action === "read") {
			await store.markRead(command.id ?? "all")
			return { status: 200, body: { ok: true, unread: await store.unreadCount() } }
		}
		if (command.action === "clear-row") {
			await store.clearById(command.id)
			return { status: 200, body: { ok: true, unread: await store.unreadCount() } }
		}
		if (command.action === "clear-condition") {
			await store.clearByKind(command.kind, command.dedupeKey)
			return { status: 200, body: { ok: true, unread: await store.unreadCount() } }
		}
		return { status: 400, body: { error: "Unknown action" } }
	} catch (error) {
		return failed(error, "Failed to update notifications")
	}
}
