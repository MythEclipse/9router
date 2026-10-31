/**
 * Outbound alert delivery: the siren the notification feed never had.
 *
 * The dashboard already derives quota pressure and key failures into a bell feed. That feed
 * only exists while someone is looking at the page, which is the one time an alert is useless —
 * a quota runs out at 03:00 and is discovered at noon. This module turns a notification into
 * the requests that carry it off the box.
 *
 * Four rules, each of them a way this goes wrong:
 *
 * 1. **A channel that cannot be parsed is dropped, not guessed.** A webhook URL without a
 *    scheme is not "http://…"; sending it produces a fetch error that looks like the alert
 *    fired. Unusable channels are reported so the settings page can say so.
 * 2. **Only `http` and `https`.** A `file:` or `javascript:` URL in a settings field is a
 *    credential-shaped hole: the fetch layer would happily read a local file. The scheme is
 *    checked here, before any transport sees it.
 * 3. **One message per notification, not per channel.** The text is built once and the same
 *    body is posted everywhere, so a webhook and a Telegram chat cannot disagree about what
 *    happened.
 * 4. **A sent marker is a rule, not a courtesy.** Delivery is retried by whoever calls it, so
 *    the caller needs to know which notifications already left; that is what `dedupeKey` is
 *    for, and `pendingDeliveries` is the only place that decides.
 */

/** A notification as the feed stores it. */
export interface AlertNotification {
	readonly id?: string | number | null
	readonly kind?: string | null
	readonly severity?: string | null
	readonly title?: string | null
	readonly body?: string | null
	readonly link?: string | null
	readonly dedupeKey?: string | null
}

export type AlertChannelKind = "webhook" | "telegram" | "ntfy"

/** One configured destination. */
export interface AlertChannel {
	readonly kind: AlertChannelKind
	/** The endpoint the request goes to. */
	readonly url: string
	/** Extra headers (a webhook may need an authorization header). */
	readonly headers?: Readonly<Record<string, string>>
}

/** A request to make: everything the transport needs, nothing it has to decide. */
export interface AlertDelivery {
	readonly kind: AlertChannelKind
	readonly url: string
	readonly method: "POST"
	readonly headers: Readonly<Record<string, string>>
	readonly body: string
}

/** What a settings blob may hold, before validation. */
export interface AlertChannelSettings {
	readonly webhookUrl?: unknown
	readonly telegramBotToken?: unknown
	readonly telegramChatId?: unknown
	readonly ntfyTopic?: unknown
	readonly ntfyServer?: unknown
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"])

/** A URL a transport may be handed, or `null`. */
export function usableUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.trim() === "") return null
	try {
		const parsed = new URL(value.trim())
		return ALLOWED_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null
	} catch {
		return null
	}
}

/**
 * The channels a settings blob actually configures.
 *
 * Telegram is all-or-nothing: a token without a chat has no destination, and a chat without a
 * token has no sender. Half a channel is dropped rather than reported as configured.
 */
export function channelsFrom(settings: AlertChannelSettings | null | undefined): AlertChannel[] {
	if (!settings) return []
	const channels: AlertChannel[] = []

	const webhookUrl = usableUrl(settings.webhookUrl)
	if (webhookUrl) {
		channels.push({
			kind: "webhook",
			url: webhookUrl,
			headers: { "content-type": "application/json" },
		})
	}

	const token = typeof settings.telegramBotToken === "string" ? settings.telegramBotToken.trim() : ""
	const chatId =
		typeof settings.telegramChatId === "string" || typeof settings.telegramChatId === "number"
			? String(settings.telegramChatId).trim()
			: ""
	if (token && chatId) {
		const url = usableUrl(`https://api.telegram.org/bot${token}/sendMessage`)
		if (url) channels.push({ kind: "telegram", url, headers: { "content-type": "application/json" } })
	}

	const topic = typeof settings.ntfyTopic === "string" ? settings.ntfyTopic.trim() : ""
	if (topic) {
		const server = usableUrl(settings.ntfyServer) ?? "https://ntfy.sh/"
		channels.push({
			kind: "ntfy",
			url: new URL(topic, server).toString(),
			headers: { "content-type": "text/plain; charset=utf-8" },
		})
	}

	return channels
}

/** One line per notification: severity, title, body, link. */
export function alertText(notification: AlertNotification): string {
	const severity = (notification.severity ?? "info").toUpperCase()
	const title = notification.title ?? "9Router notification"
	const body = notification.body ? `\n${notification.body}` : ""
	const link = notification.link ? `\n${notification.link}` : ""
	return `[${severity}] ${title}${body}${link}`
}

/** The key a notification is remembered by once delivered. */
export function markerOf(notification: AlertNotification): string | null {
	if (typeof notification.dedupeKey === "string" && notification.dedupeKey) {
		return notification.dedupeKey
	}
	if (notification.id !== null && notification.id !== undefined) return `id:${notification.id}`
	return null
}

/** The request body for one channel, in the shape that channel expects. */
function bodyFor(channel: AlertChannel, text: string): string {
	if (channel.kind === "telegram") return JSON.stringify({ text, disable_web_page_preview: true })
	if (channel.kind === "ntfy") return text
	return JSON.stringify({ text })
}

/**
 * The deliveries one notification needs, for the channels configured.
 *
 * A notification without a marker is skipped: without one there is no way to remember that it
 * was sent, so every dispatch would send it again.
 */
export function deliveriesFor(
	notification: AlertNotification,
	channels: readonly AlertChannel[],
): AlertDelivery[] {
	if (markerOf(notification) === null) return []
	const text = alertText(notification)
	return channels.map((channel) => ({
		kind: channel.kind,
		url: channel.url,
		method: "POST",
		headers: channel.headers ?? { "content-type": "application/json" },
		body: bodyFor(channel, text),
	}))
}

/**
 * The notifications that have not been delivered yet.
 *
 * `sent` holds the markers already recorded; a notification whose marker is in there is done.
 * Ordering is the caller's: the feed is already newest-first.
 */
export function pendingDeliveries(
	notifications: readonly AlertNotification[],
	sent: ReadonlySet<string>,
): AlertNotification[] {
	return notifications.filter((notification) => {
		const marker = markerOf(notification)
		return marker !== null && !sent.has(marker)
	})
}
