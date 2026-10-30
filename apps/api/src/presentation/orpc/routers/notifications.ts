/**
 * The notification bell's procedures.
 *
 * The store is injected rather than imported because `notificationsRepo` opens the database; the
 * rules — who may read the feed, which command a body names, what the limit may be — are in
 * `domain/notification-feed` and are applied by the use-case, not here.
 */
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import type {
	NoticeWording,
	NotificationScanStore,
} from "../../../application/notifications/scan-notifications.ts"
import { type AppContext, authed } from "../base.ts"

type NotificationStore = NonNullable<AppContext["notificationStore"]>

type ScanStore = NonNullable<AppContext["notificationScanStore"]>

type Wording = NonNullable<AppContext["noticeWording"]>

const wordingOf = (wording: Wording | undefined): NoticeWording => {
	if (!wording) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "The notification wording is not wired into this client",
		})
	}
	return wording
}

const scanStoreOf = (store: ScanStore | undefined): NotificationScanStore => {
	if (!store) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "The notification scan store is not wired into this client",
		})
	}
	return store
}

const storeOf = (store: NotificationStore | undefined): NotificationStore => {
	if (!store) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "The notification store is not wired into this client",
		})
	}
	return store
}

export const notificationsRouter = {
	/**
	 * The feed. `limit` is a string on the wire because it comes from a query parameter; the
	 * domain clamps it.
	 */
	list: authed
		.input(z.object({ limit: z.string().nullish() }))
		.handler(async ({ input, context }) =>
			context.useCases.notifications.read(
				context.session,
				input.limit,
				storeOf(context.notificationStore),
			),
		),

	/**
	 * Derive conditions into the feed. The wording comes from the client because it is the
	 * dashboard's copy, not a rule; the dedupe and sweep live in the domain.
	 */
	scan: authed.handler(async ({ context }) =>
		context.useCases.notifications.scan(
			context.session,
			scanStoreOf(context.notificationScanStore),
			wordingOf(context.noticeWording),
		),
	),

	/** Mark read, dismiss a row, or clear a condition — the body names which. */
	update: authed
		.input(z.object({ body: z.unknown() }))
		.handler(async ({ input, context }) =>
			context.useCases.notifications.update(
				context.session,
				input.body,
				storeOf(context.notificationStore),
			),
		),
}
