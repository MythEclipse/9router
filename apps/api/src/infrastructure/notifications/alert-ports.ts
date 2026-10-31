/**
 * The alert ports: stored channel settings, the feed's notifications, the marker list, and the
 * HTTP transport.
 *
 * The transport refuses a non-2xx answer by throwing, because a webhook that answers 500 has
 * not delivered anything and the marker must not be written. It times out after ten seconds:
 * an alerting path that can hang is worse than one that fails, since the caller is a poll that
 * would then block the dashboard behind it.
 *
 * **On the addresses this will dial.** The URL comes from an authenticated administrator's
 * settings, never from request input, so a private or loopback host is allowed on purpose — a
 * self-hosted ntfy on the LAN is a legitimate destination. What is *not* negotiable is the
 * scheme, and that is checked in the domain rule before this file sees a URL.
 */
import { getAlertMarkers, recordAlertMarkers } from "@9router/db/repos/alertMarkersRepo"
import { listNotifications } from "@9router/db/repos/notificationsRepo"
import { getSettings } from "@9router/db/repos/settingsRepo"
import type { AlertPorts } from "../../application/notifications/dispatch-alerts.ts"
import type {
	AlertChannelSettings,
	AlertDelivery,
	AlertNotification,
} from "../../domain/alert-channels.ts"

/** Seconds a delivery may take before it counts as failed. */
const DELIVERY_TIMEOUT_MS = 10_000

/** The `alerts` block of the settings row, if the operator wrote one. */
async function alertSettings(): Promise<AlertChannelSettings | null> {
	const settings = (await getSettings()) as Record<string, unknown> | null
	const alerts = settings?.alerts
	if (alerts === null || typeof alerts !== "object") return null
	return alerts as AlertChannelSettings
}

/** The feed's recent notifications, mapped to the shape the rule reads. */
async function recentNotifications(): Promise<readonly AlertNotification[]> {
	const { notifications } = await listNotifications({ limit: 50 })
	return notifications.map((notification) => ({
		id: notification.id,
		kind: notification.kind,
		severity: notification.severity,
		title: notification.title,
		body: notification.body,
		link: notification.link,
	}))
}

async function send(delivery: AlertDelivery): Promise<void> {
	const answer = await fetch(delivery.url, {
		method: delivery.method,
		headers: delivery.headers,
		body: delivery.body,
		signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
	})
	if (!answer.ok) {
		throw new Error(`alert destination answered ${answer.status}`)
	}
}

export function alertPorts(): AlertPorts {
	return {
		settings: alertSettings,
		unread: recentNotifications,
		sentMarkers: getAlertMarkers,
		recordSent: recordAlertMarkers,
		send,
	}
}
