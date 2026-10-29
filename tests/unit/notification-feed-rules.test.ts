import { describe, expect, test } from "vitest"
import {
	canReadNotifications,
	notificationCommand,
	notificationLimit,
} from "../../apps/api/src/domain/notification-feed"

describe("notificationCommand", () => {
	test("read with no id means every row", () => {
		// The mark-all-read button sends {action: "read"} and nothing else.
		expect(notificationCommand({ action: "read" })).toEqual({ action: "read", id: null })
	})

	test("read with an id names one row", () => {
		expect(notificationCommand({ action: "read", id: "n1" })).toEqual({
			action: "read",
			id: "n1",
		})
	})

	test("clear with an id dismisses that row", () => {
		expect(notificationCommand({ action: "clear", id: "n1" })).toEqual({
			action: "clear-row",
			id: "n1",
		})
	})

	test("clear without an id retires a condition", () => {
		// Not the same as dismissing a row: this is the scan saying the problem is over.
		expect(
			notificationCommand({ action: "clear", kind: "quota", dedupeKey: "q:1:tokens:warning" }),
		).toEqual({ action: "clear-condition", kind: "quota", dedupeKey: "q:1:tokens:warning" })
	})

	test("an empty id counts as absent, so a bare clear retires a condition", () => {
		expect(notificationCommand({ action: "clear", id: "", kind: "quota" })).toMatchObject({
			action: "clear-condition",
		})
	})

	test("an unknown or missing action is reported, not guessed", () => {
		expect(notificationCommand({ action: "delete" })).toEqual({ action: "unknown" })
		expect(notificationCommand({})).toEqual({ action: "unknown" })
		expect(notificationCommand(null)).toEqual({ action: "unknown" })
	})
})

describe("notificationLimit", () => {
	test("a positive number passes through", () => {
		expect(notificationLimit("10")).toBe(10)
	})

	test("no limit asks for the repo default", () => {
		expect(notificationLimit(null)).toBe(undefined)
		expect(notificationLimit("")).toBe(undefined)
		expect(notificationLimit(undefined)).toBe(undefined)
	})

	test("a non-numeric or non-positive limit is dropped, not turned into NaN", () => {
		// Number("abc") is NaN, and a NaN limit reaches the adapter as an unbindable offset.
		expect(notificationLimit("abc")).toBe(undefined)
		expect(notificationLimit("0")).toBe(undefined)
		expect(notificationLimit("-5")).toBe(undefined)
	})
})

describe("canReadNotifications", () => {
	test("an owner session can read the feed", () => {
		expect(canReadNotifications({ role: "owner" })).toBe(true)
	})

	test("a session with no role still reads as an owner session", () => {
		expect(canReadNotifications({})).toBe(true)
	})

	test("a key session is refused: quota pressure is administrator information", () => {
		expect(canReadNotifications({ role: "apikey" })).toBe(false)
	})

	test("no session is refused", () => {
		expect(canReadNotifications(null)).toBe(false)
		expect(canReadNotifications(undefined)).toBe(false)
	})
})
