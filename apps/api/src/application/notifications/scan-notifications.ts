/**
 * Deriving conditions into notifications.
 *
 * A notification is written once per condition (`dedupeKey`), so this can run on every dashboard
 * load without flooding the feed, and each condition clears itself when it stops being true — so
 * a resolved problem stops nagging and a relapse is announced again. The dedupe and sweep rules
 * live in `domain/notification-scan.ts`; this does the reads and writes around them.
 *
 * **A failed scan is not an error the caller sees.** Deriving conditions must never break the
 * dashboard: the bell is decoration, and a 500 here would take the whole page down with it. The
 * failure is logged and the answer says "nothing created", which is indistinguishable from a
 * quiet install — that is the trade, and it is deliberate.
 */
import {
	planQuotaNotices,
	QUOTA_NOTICE_KIND,
	QUOTA_NOTICE_LINK,
	type QuotaState,
	staleQuotaKeys,
} from "../../domain/notification-scan.ts"

/** A key as the scan reads it. Only the shape the domain needs; the rest is carried through. */
export type ScanKey = Readonly<Record<string, unknown>> & {
	readonly id?: string | number | null
}

export interface NotificationScanStore {
	readonly keys: () => Promise<readonly ScanKey[]>
	readonly notify: (input: {
		readonly kind: string
		readonly severity: string
		readonly title: string
		readonly body: string
		readonly link: string
		readonly dedupeKey: string
	}) => Promise<unknown>
	readonly clearByKind: (kind: string, dedupeKey: string) => Promise<unknown>
	readonly clearAllOfKind: (kind: string) => Promise<unknown>
}

/** The wording, supplied by the caller: it is presentation, not a rule. */
export interface NoticeWording {
	readonly pressure: (key: ScanKey) => QuotaState | null
	readonly title: (key: ScanKey | undefined, pressure: QuotaState | undefined) => string
	readonly body: (pressure: QuotaState | undefined) => string
}

export interface ScanAnswer {
	readonly status: number
	readonly body: { readonly created: readonly string[]; readonly checkedAt?: string }
}

const unauthorized = (): ScanAnswer => ({ status: 401, body: { created: [] } })

/** Key names and quota pressure are administrator facts, so a key session derives nothing. */
const mayScan = (session: unknown): boolean => {
	if (session === null || session === undefined) return false
	return (session as { role?: unknown }).role !== "apikey"
}

export async function scanNotifications(
	session: unknown,
	store: NotificationScanStore,
	wording: NoticeWording,
	now: () => Date = () => new Date(),
): Promise<ScanAnswer> {
	if (!mayScan(session)) return unauthorized()

	// Declared outside the `try` so the answer carries whatever was created before a failure.
	const created: string[] = []
	try {
		await store.clearAllOfKind("update")

		const keys = (await store.keys()) ?? []
		// The pressure is kept per key so the wording can be built without deriving it a second
		// time — across a midnight rollover the second read can disagree with the first.
		const pressureById = new Map<string, QuotaState>()
		const { notices, live } = planQuotaNotices(keys, (key) => {
			const pressure = wording.pressure(key as ScanKey)
			if (pressure) pressureById.set(String((key as ScanKey)?.id ?? ""), pressure)
			return pressure
		})

		for (const notice of notices) {
			const key = keys.find((k) => String(k?.id) === notice.keyId)
			const pressure = pressureById.get(notice.keyId)
			await store.notify({
				kind: QUOTA_NOTICE_KIND,
				severity: notice.severity,
				title: wording.title(key, pressure),
				body: wording.body(pressure),
				link: QUOTA_NOTICE_LINK,
				dedupeKey: notice.dedupeKey,
			})
			created.push(`quota:${notice.keyId}`)
		}

		// Clear every notice this pass did not recreate: recovered, raised, deactivated, or
		// switched to a different budget kind.
		for (const dedupeKey of staleQuotaKeys(keys, live)) {
			await store.clearByKind(QUOTA_NOTICE_KIND, dedupeKey)
		}
	} catch (error) {
		console.warn("[notifications] scan failed:", (error as { message?: string })?.message ?? error)
	}

	return { status: 200, body: { created, checkedAt: now().toISOString() } }
}
