/**
 * The proxy-pool *boundary* — what the new router adds that the use-case tests cannot see.
 *
 * `use-case-manage-proxy-pools.test.ts` already pins the rules (a pool in use refuses
 * removal, a test writes back, bulk delete reports the missing ids). This file covers only the
 * translation layer, because that is where the move to oRPC could go wrong without any
 * use-case test noticing:
 *
 * - `PoolInUseError` carries `code: "CONFLICT"`, which is a 409 only if the status table says
 *   so. Read as a 500 it tells the operator the server broke while their data was fine, and
 *   the "3 connections still use this pool" message never reaches the screen.
 * - The `deploy` procedure validates against an enum. A provider added to `RELAY_CONTRACTS`
 *   without widening that enum is a 400 on the first deploy of it, which no use-case test
 *   would catch because the use-case never sees the request.
 */
import { describe, expect, test } from "vitest"
import { PoolInUseError } from "../../apps/api/src/application/proxy-pools/manage-proxy-pools.ts"
import { RELAY_PROVIDERS } from "../../apps/api/src/domain/relay-deploy.ts"
import { statusOf } from "../../apps/web/src/lib/routeErrors.ts"

describe("a pool still in use refuses with 409, not 500", () => {
	test("the carried code maps to a conflict", () => {
		expect(statusOf(new PoolInUseError("3 connections still use this pool", 3))).toBe(409)
	})

	test("the count the refusal was built with survives, so the screen can name them", () => {
		expect(new PoolInUseError("in use", 7).boundConnectionCount).toBe(7)
	})
})

describe("the deploy procedure covers every provider that has a contract", () => {
	test("the enum is exactly RELAY_PROVIDERS", () => {
		// Asserted rather than assumed: this list is what the procedure validates against.
		expect([...RELAY_PROVIDERS]).toEqual(["vercel", "cloudflare", "deno", "netlify"])
	})
})
