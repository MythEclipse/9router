/**
 * Dispatch alerts to the configured channels.
 *
 * The rule is "one notification leaves the box once", and it is enforced by a marker store
 * rather than by memory: the caller may retry a dispatch (a cron, a dashboard poll), and a
 * notification already sent must not be sent again. `domain/alert-channels.ts` decides which
 * notifications are pending; this decides what to do when a send fails.
 *
 * **A failed channel does not stop the others, and does not mark the notification sent.** The
 * marker is written only when at least one channel accepted the message — otherwise a Telegram
 * outage would permanently silence a webhook that was working, and the next attempt would skip
 * a notification nobody received.
 */
import {
	type AlertChannelSettings,
	type AlertDelivery,
	type AlertNotification,
	channelsFrom,
	deliveriesFor,
	markerOf,
	pendingDeliveries,
} from "../../domain/alert-channels.ts"

export interface AlertPorts {
	/** The channel settings as stored; `null` when nothing is configured. */
	readonly settings: () => Promise<AlertChannelSettings | null>
	/** The feed's recent notifications, newest first. */
	readonly unread: () => Promise<readonly AlertNotification[]>
	/** Markers already delivered. */
	readonly sentMarkers: () => Promise<readonly string[]>
	readonly recordSent: (markers: readonly string[]) => Promise<void>
	/** The transport. Throws when the destination refused the message. */
	readonly send: (delivery: AlertDelivery) => Promise<void>
}

export interface DispatchReport {
	readonly channels: number
	readonly considered: number
	readonly delivered: number
	readonly failed: number
	readonly skipped: number
}

export interface AlertDispatchUseCase {
	readonly dispatch: () => Promise<DispatchReport>
	/** Send a synthetic notification to every channel, so a broken config is found now. */
	readonly test: () => Promise<DispatchReport>
}

const TEST_NOTIFICATION: AlertNotification = {
	id: "test",
	kind: "test",
	severity: "info",
	title: "9Router test alert",
	body: "If you can read this, the channel is configured correctly.",
	link: "",
}

export function makeDispatchAlerts(ports: AlertPorts): AlertDispatchUseCase {
	/** Distinguishes two tests fired in the same millisecond; the marker must still be unique. */
	let testSequence = 0

	async function deliver(notifications: readonly AlertNotification[]): Promise<DispatchReport> {
		const channels = channelsFrom(await ports.settings())
		if (channels.length === 0) {
			return { channels: 0, considered: 0, delivered: 0, failed: 0, skipped: 0 }
		}

		const sent = new Set(await ports.sentMarkers())
		const pending = pendingDeliveries(notifications, sent)
		const deliveredMarkers: string[] = []
		let delivered = 0
		let failed = 0

		for (const notification of pending) {
			const deliveries = deliveriesFor(notification, channels)
			let accepted = false
			for (const delivery of deliveries) {
				try {
					await ports.send(delivery)
					accepted = true
				} catch {
					// One channel refusing is not the notification's failure: the others may have
					// taken it, and the marker below records only what was accepted somewhere.
					failed += 1
				}
			}
			if (accepted) {
				delivered += 1
				const marker = markerOf(notification)
				if (marker) deliveredMarkers.push(marker)
			}
		}

		if (deliveredMarkers.length > 0) await ports.recordSent(deliveredMarkers)

		return {
			channels: channels.length,
			considered: pending.length,
			delivered,
			failed,
			skipped: notifications.length - pending.length,
		}
	}

	return {
		async dispatch() {
			return deliver(await ports.unread())
		},

		async test() {
			// The test notification carries a fresh marker every time, so a test always sends.
			testSequence += 1
			return deliver([{ ...TEST_NOTIFICATION, id: `test-${Date.now()}-${testSequence}` }])
		},
	}
}
