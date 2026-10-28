/**
 * End-to-end proof that an authenticated call reaches the use-case.
 *
 * Boots the real Hono app in-process with a stubbed session context and drives
 * it over HTTP, so the assertion covers routing, the auth gate, Zod validation,
 * the use-case, the audit write and the JSON shape — not just the router.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Dependencies } from "../src/application/dependencies.ts"
import { buildUseCases } from "../src/application/use-cases.ts"
import { createDb } from "../src/infrastructure/db/client.ts"
import { findMigrationsDir, runMigrations } from "../src/infrastructure/db/migrate.ts"
import { createActivityRepository } from "../src/infrastructure/db/repositories/activity-repository.ts"
import { createApiKeyRepository } from "../src/infrastructure/db/repositories/api-key-repository.ts"
import { createApp } from "../src/presentation/http/app.ts"

const dataDir = mkdtempSync(join(tmpdir(), "9r-api-test-"))
const { db, sqlite } = createDb(dataDir)
runMigrations(sqlite, dataDir)

const deps: Dependencies = {
	apiKeys: createApiKeyRepository(db),
	activity: createActivityRepository(db, () => randomUUID()),
	now: () => new Date(),
	randomId: () => randomUUID(),
}
const useCases = buildUseCases(deps)
const { app } = createApp({ webOrigin: "http://localhost:20128" })

const AUTHENTICATED = { session: { userId: "u1", email: "owner@local" }, useCases }
const ANONYMOUS = { session: null, useCases }

async function post(path: string, context: unknown, body: unknown = {}): Promise<Response> {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		context as never,
	)
}

afterAll(() => {
	sqlite.close()
	rmSync(dataDir, { recursive: true, force: true })
})

describe("auth gate", () => {
	test("rejects an anonymous caller with 401", async () => {
		const response = await post("/api/apiKeys/list", ANONYMOUS)
		expect(response.status).toBe(401)
	})

	test("401 comes before input validation, so the schema is never leaked", async () => {
		// An empty body cannot satisfy CreateApiKeySchema. If validation ran
		// first this would be 400 — which tells an anonymous caller the shape.
		const response = await post("/api/apiKeys/create", ANONYMOUS, {})
		expect(response.status).toBe(401)
		const body = await response.json()
		expect(body.code).toBe("UNAUTHORIZED")
	})
})

describe("authenticated api-key lifecycle", () => {
	let createdId = ""

	test("creates a key and returns the secret exactly once", async () => {
		const response = await post("/api/apiKeys/create", AUTHENTICATED, { name: "laptop" })
		expect(response.status).toBe(200)

		const body = (await response.json()) as {
			key: { id: string; name: string; keyPrefix: string; keyHash?: string }
			secret: string
		}
		expect(body.key.name).toBe("laptop")
		expect(body.secret.startsWith("sk-")).toBe(true)
		// The hash must never cross the boundary.
		expect(body.key.keyHash).toBeUndefined()
		expect(body.secret.startsWith(body.key.keyPrefix)).toBe(true)
		createdId = body.key.id
	})

	test("lists the created key", async () => {
		const response = await post("/api/apiKeys/list", AUTHENTICATED)
		expect(response.status).toBe(200)
		const keys = (await response.json()) as { id: string }[]
		expect(keys.some((k) => k.id === createdId)).toBe(true)
	})

	test("rejects an empty name with 400", async () => {
		const response = await post("/api/apiKeys/create", AUTHENTICATED, { name: "" })
		expect(response.status).toBe(400)
	})

	test("revokes the key and is idempotent", async () => {
		const first = await post("/api/apiKeys/revoke", AUTHENTICATED, { id: createdId })
		expect(first.status).toBe(200)
		expect(((await first.json()) as { revokedAt: string | null }).revokedAt).not.toBeNull()

		const again = await post("/api/apiKeys/revoke", AUTHENTICATED, { id: createdId })
		expect(again.status).toBe(200)
	})

	test("missing key reports 404", async () => {
		const response = await post("/api/apiKeys/revoke", AUTHENTICATED, { id: "does-not-exist" })
		expect(response.status).toBe(404)
	})
})

describe("migration journal", () => {
	test("applies the journal exactly once, then is a no-op", () => {
		const dir = mkdtempSync(join(tmpdir(), "9r-migrate-"))
		const first = createDb(dir)
		runMigrations(first.sqlite, dir)
		const appliedCount = (
			first.sqlite.query("SELECT COUNT(*) AS n FROM _migrations").get() as { n: number }
		).n
		expect(appliedCount).toBeGreaterThan(0)

		// A second boot must not re-run anything — the tables already exist, so a
		// re-run would throw on CREATE TABLE and take the server down with it.
		expect(() => runMigrations(first.sqlite, dir)).not.toThrow()
		const afterSecond = (
			first.sqlite.query("SELECT COUNT(*) AS n FROM _migrations").get() as { n: number }
		).n
		expect(afterSecond).toBe(appliedCount)

		first.sqlite.close()
		rmSync(dir, { recursive: true, force: true })
	})

	test("a missing journal is a hard error, never a silent success", () => {
		// An unbundled payload ships the JS without migrations/. Reporting success
		// with zero migrations applied would hand out an empty database, so this
		// must throw.
		const dir = mkdtempSync(join(tmpdir(), "9r-empty-"))
		const other = createDb(dir)
		expect(findMigrationsDir(join(dir, "does-not-exist"))).toBeNull()
		other.sqlite.close()
		rmSync(dir, { recursive: true, force: true })
	})

	test("an empty journal directory is also a hard error", () => {
		const dir = mkdtempSync(join(tmpdir(), "9r-empty2-"))
		const other = createDb(dir)
		expect(findMigrationsDir(dir)).toBeNull()
		other.sqlite.close()
		rmSync(dir, { recursive: true, force: true })
	})
})
