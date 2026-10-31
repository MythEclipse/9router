/**
 * Outbound alerts: the four ways a siren fails to sound.
 *
 * Each case below is a silent failure in production — an unusable channel reported as
 * configured, a `file:` URL handed to the transport, one channel's outage silencing the
 * others, and a notification re-sent on every retry.
 */

import {
	type AlertPorts,
	makeDispatchAlerts,
} from "9router-api/application/notifications/dispatch-alerts"
import {
	type AlertChannelSettings,
	alertText,
	channelsFrom,
	deliveriesFor,
	markerOf,
	pendingDeliveries,
	usableUrl,
} from "9router-api/domain/alert-channels"
import { describe, expect, it } from "vitest"

describe("usableUrl", () => {
	it("accepts http and https", () => {
		expect(usableUrl("https://example.com/hook")).toBe("https://example.com/hook")
		expect(usableUrl("http://10.0.0.5:8080/hook")).toBe("http://10.0.0.5:8080/hook")
	})

	it("refuses a scheme the transport would happily read a file with", () => {
		expect(usableUrl("file:///etc/passwd")).toBeNull()
		expect(usableUrl("javascript:alert(1)")).toBeNull()
	})

	it("refuses a value that is not a URL at all", () => {
		// A bare host is not "http://host": sending it fails later in a way that looks like the
		// alert fired.
		expect(usableUrl("example.com/hook")).toBeNull()
		expect(usableUrl("")).toBeNull()
		expect(usableUrl(null)).toBeNull()
	})
})

describe("channelsFrom", () => {
	it("builds a webhook channel from a usable URL", () => {
		const channels = channelsFrom({ webhookUrl: "https://example.com/hook" })

		expect(channels).toHaveLength(1)
		expect(channels[0]?.kind).toBe("webhook")
	})

	it("drops a webhook URL it cannot use instead of guessing a scheme", () => {
		expect(channelsFrom({ webhookUrl: "example.com/hook" })).toEqual([])
	})

	it("requires both halves of a Telegram channel", () => {
		expect(channelsFrom({ telegramBotToken: "t" })).toEqual([])
		expect(channelsFrom({ telegramChatId: "1" })).toEqual([])
		expect(channelsFrom({ telegramBotToken: "t", telegramChatId: 42 })[0]?.kind).toBe("telegram")
	})

	it("defaults the ntfy server and keeps a custom one", () => {
		expect(channelsFrom({ ntfyTopic: "alerts" })[0]?.url).toBe("https://ntfy.sh/alerts")
		expect(
			channelsFrom({ ntfyTopic: "alerts", ntfyServer: "https://ntfy.example.com" })[0]?.url,
		).toBe("https://ntfy.example.com/alerts")
	})

	it("answers nothing for an install with no settings", () => {
		expect(channelsFrom(null)).toEqual([])
		expect(channelsFrom({})).toEqual([])
	})
})

describe("alertText", () => {
	it("carries severity, title, body and link", () => {
		const text = alertText({
			severity: "warning",
			title: "Quota low",
			body: "3% left on key X",
			link: "/dashboard/quota",
		})

		expect(text).toBe("[WARNING] Quota low\n3% left on key X\n/dashboard/quota")
	})

	it("says info when the severity is missing", () => {
		expect(alertText({ title: "Hello" })).toBe("[INFO] Hello")
	})
})

describe("markerOf", () => {
	it("prefers the dedupe key, so a condition is announced once", () => {
		expect(markerOf({ dedupeKey: "quota:k1", id: "ntf_1" })).toBe("quota:k1")
	})

	it("falls back to the row id", () => {
		expect(markerOf({ id: "ntf_1" })).toBe("id:ntf_1")
	})

	it("answers null when there is nothing to remember it by", () => {
		expect(markerOf({})).toBeNull()
	})
})

describe("deliveriesFor", () => {
	const channels = channelsFrom({
		webhookUrl: "https://example.com/hook",
		telegramBotToken: "tok",
		telegramChatId: "7",
	})

	it("builds one delivery per channel with the same text", () => {
		const deliveries = deliveriesFor({ id: "n1", title: "Hello" }, channels)

		expect(deliveries).toHaveLength(2)
		expect(deliveries.every((delivery) => delivery.body.includes("Hello"))).toBe(true)
		expect(deliveries.every((delivery) => delivery.method === "POST")).toBe(true)
	})

	it("shapes the body for Telegram, which wants JSON", () => {
		const telegram = deliveriesFor({ id: "n1", title: "Hello" }, channels).find(
			(delivery) => delivery.kind === "telegram",
		)

		expect(JSON.parse(telegram?.body ?? "{}")).toMatchObject({ text: "[INFO] Hello" })
	})

	it("sends nothing for a notification it cannot remember", () => {
		// Without a marker every dispatch would re-send it.
		expect(deliveriesFor({ title: "Hello" }, channels)).toEqual([])
	})
})

describe("pendingDeliveries", () => {
	it("drops what was already delivered", () => {
		const pending = pendingDeliveries([{ id: "n1" }, { id: "n2" }], new Set(["id:n1"]))

		expect(pending.map((n) => n.id)).toEqual(["n2"])
	})
})

/** A port set with a fixed feed and a recording transport. */
function ports(
	settings: AlertChannelSettings | null,
	feed: Array<Record<string, unknown>> = [{ id: "n1", title: "Quota low", severity: "warning" }],
	options: { failAll?: boolean; sent?: string[] } = {},
) {
	const sent: string[] = options.sent ? [...options.sent] : []
	const attempts: Array<{ url: string; body: string }> = []
	const port: AlertPorts = {
		settings: async () => settings,
		unread: async () => feed as never,
		sentMarkers: async () => sent,
		recordSent: async (markers) => {
			sent.push(...markers)
		},
		send: async (delivery) => {
			attempts.push({ url: delivery.url, body: delivery.body })
			if (options.failAll) throw new Error("refused")
		},
	}
	return { port, sent, attempts }
}

describe("makeDispatchAlerts", () => {
	it("does nothing at all when no channel is configured", async () => {
		const { port, attempts } = ports(null)
		const report = await makeDispatchAlerts(port).dispatch()

		expect(report.channels).toBe(0)
		expect(attempts).toHaveLength(0)
	})

	it("delivers a pending notification and remembers it", async () => {
		const { port, sent, attempts } = ports({ webhookUrl: "https://example.com/hook" })
		const report = await makeDispatchAlerts(port).dispatch()

		expect(report.delivered).toBe(1)
		expect(attempts).toHaveLength(1)
		expect(sent).toEqual(["id:n1"])
	})

	it("does not deliver the same notification twice", async () => {
		const { port, attempts } = ports({ webhookUrl: "https://example.com/hook" }, undefined, {
			sent: ["id:n1"],
		})
		const report = await makeDispatchAlerts(port).dispatch()

		expect(report.delivered).toBe(0)
		expect(report.skipped).toBe(1)
		expect(attempts).toHaveLength(0)
	})

	it("keeps going when one channel fails, and still marks it delivered", async () => {
		const sent: string[] = []
		const attempted: string[] = []
		const port: AlertPorts = {
			settings: async () => ({
				webhookUrl: "https://example.com/hook",
				telegramBotToken: "t",
				telegramChatId: "1",
			}),
			unread: async () => [{ id: "n1", title: "Hello" }],
			sentMarkers: async () => sent,
			recordSent: async (markers) => {
				sent.push(...markers)
			},
			send: async (delivery) => {
				attempted.push(delivery.kind)
				if (delivery.kind === "telegram") throw new Error("telegram down")
			},
		}

		const report = await makeDispatchAlerts(port).dispatch()

		expect(attempted).toEqual(["webhook", "telegram"])
		expect(report.delivered).toBe(1)
		expect(report.failed).toBe(1)
		expect(sent).toEqual(["id:n1"])
	})

	it("does not mark a notification sent when every channel failed", async () => {
		// Otherwise a Telegram outage would silence a webhook that was never even reachable.
		const { port, sent } = ports({ webhookUrl: "https://example.com/hook" }, undefined, {
			failAll: true,
		})
		const report = await makeDispatchAlerts(port).dispatch()

		expect(report.delivered).toBe(0)
		expect(sent).toEqual([])
	})

	it("sends a fresh test message every time it is asked", async () => {
		const { port, attempts } = ports({ webhookUrl: "https://example.com/hook" }, [])
		const useCase = makeDispatchAlerts(port)

		await useCase.test()
		await useCase.test()

		expect(attempts).toHaveLength(2)
		expect(attempts[0]?.body).toContain("test alert")
	})
})
