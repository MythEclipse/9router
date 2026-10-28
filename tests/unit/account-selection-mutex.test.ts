// Account selection used to serialise EVERY provider behind one process-wide
// mutex promise chain. That is invisible under fill-first (selection is
// read-only), but round-robin writes the chosen account's lastUsedAt and
// consecutiveUseCount inside the critical section, so with one provider on
// round-robin every other provider's selection queued behind that DB write.
//
// The lock is now per provider: an account belongs to exactly one provider, and
// the strategy / sticky limit are read per provider, so cross-provider ordering
// never mattered.
import { describe, expect, it } from "vitest"

// These drive the lock itself rather than the selection path. An end-to-end
// version was flaky, and the reason is worth recording: the default driver
// (node:sqlite) is SYNCHRONOUS, so a selection's critical section never yields to
// the event loop. Two providers therefore never visibly overlap even when their
// locks are independent, and any wall-clock comparison ends up measuring
// scheduler noise. A deterministic gate on the critical section proves the same
// property exactly, with no thresholds.
const { acquireSelectionMutex } = await import("../../src/sse/services/auth.js")

/** Run `fn` as `key`'s critical section, recording enter/exit order. */
async function section(key, tag, events, fn) {
	const mutex = acquireSelectionMutex(key)
	await mutex.wait
	events.push(`${tag}:enter`)
	try {
		return await fn()
	} finally {
		events.push(`${tag}:exit`)
		mutex.release()
	}
}

describe("account selection mutex", () => {
	it("serialises the same provider: no two sections of one key interleave", async () => {
		const events = []

		// Three concurrent holders of ONE key. Each records enter, yields, records
		// exit. Without the lock all three would enter first.
		await Promise.all([
			section("prova", "a", events, () => new Promise((r) => setTimeout(r, 5))),
			section("prova", "b", events, () => new Promise((r) => setTimeout(r, 5))),
			section("prova", "c", events, () => new Promise((r) => setTimeout(r, 5))),
		])

		// Strictly nested enter/exit pairs, never two enters in a row. This is the
		// property the round-robin rotation state depends on.
		expect(events).toHaveLength(6)
		for (let i = 0; i < events.length; i += 2) {
			expect(events[i]).toMatch(/:enter$/)
			expect(events[i + 1]).toMatch(/:exit$/)
			expect(events[i].split(":")[0]).toBe(events[i + 1].split(":")[0])
		}
	})

	it("does not serialise different providers against each other", async () => {
		const events = []
		// A holds its key and only finishes once B has entered. With a SHARED lock B
		// could never enter, so this deadlocks rather than fails on a threshold.
		let bEntered
		const bDidEnter = new Promise((r) => {
			bEntered = r
		})

		const a = section("prova", "a", events, async () => {
			await bDidEnter
			return "a"
		})

		const b = section("provb", "b", events, async () => {
			bEntered()
			return "b"
		})

		await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"])
		// B entered while A was still open: the two keys are independent.
		expect(events).toEqual(["a:enter", "b:enter", "b:exit", "a:exit"])
	})

	it("releases cleanly, so the same key can be taken again immediately", async () => {
		// Enough distinct keys to catch a leaked queue entry, then reuse one.
		await Promise.all(
			Array.from({ length: 50 }, (_, i) => section(`prov-${i}`, `k${i}`, [], async () => i)),
		)

		// A leaked queue would hang this forever.
		const again = await section("prov-0", "again", [], async () => "ok")
		expect(again).toBe("ok")
	})

	it("keys the lock on the PROVIDER, not on a shared global", async () => {
		// The three tests above pass even if getProviderCredentials locked on one
		// constant key, because they exercise acquireSelectionMutex directly.
		//
		// A behavioural version of this check does NOT work here, and that is worth
		// recording because it was tried: holding a key and asserting another
		// provider still settles stays green under the regression, since a global-key
		// implementation simply takes a different key than the one held, and the
		// synchronous driver makes the two orderings indistinguishable by timing.
		// What actually regressed historically is the KEY EXPRESSION at the call
		// site, so assert on that directly — the same tripwire style the repo already
		// uses for things a runtime probe cannot see.
		const fs = await import("node:fs")
		const url = await import("node:url")
		const src = fs.readFileSync(
			url.fileURLToPath(new URL("../../src/sse/services/auth.ts", import.meta.url)),
			"utf8",
		)

		// The selection must lock on the resolved provider id...
		expect(src).toMatch(/acquireSelectionMutex\(\s*resolveProviderId\(/)
		// ...and nowhere may it fall back to a constant shared key.
		expect(src).not.toMatch(/acquireSelectionMutex\(\s*["'`]/)
	})
})
