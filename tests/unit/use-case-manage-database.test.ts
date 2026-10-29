import { describe, expect, it, vi } from "vitest"
import {
	type DatabaseDeps,
	readDatabase,
	readDatabaseJob,
	startDatabaseJob,
	writeDatabase,
} from "../../apps/api/src/application/settings/manage-database.ts"
import { MAX_IMPORT_BYTES } from "../../apps/api/src/domain/database-access.ts"

const NO_CREDENTIALS = { cli: false, password: null, pollToken: null }

function deps(overrides: Partial<DatabaseDeps> = {}): DatabaseDeps {
	return {
		verifyPassword: vi.fn(async () => true),
		summary: vi.fn(async () => ({ keys: 3 })),
		exportSections: vi.fn(async () => ({ payload: true })),
		importPayload: vi.fn(async () => undefined),
		afterImport: vi.fn(async () => undefined),
		startJob: vi.fn(() => ({ jobId: "job-1", status: "queued", pollToken: "tok" })),
		findJob: vi.fn(() => null),
		verifyPollToken: vi.fn(() => true),
		...overrides,
	}
}

const params = (query = "") => new URLSearchParams(query)

describe("readDatabase", () => {
	it("answers the summary without verifying any password", async () => {
		const d = deps()
		await readDatabase(
			{ searchParams: params("summary=true"), credentials: NO_CREDENTIALS, contentLength: null },
			d,
		)
		expect(d.summary).toHaveBeenCalledOnce()
		expect(d.verifyPassword).not.toHaveBeenCalled()
	})

	it("refuses a full export without a password", async () => {
		const d = deps({ verifyPassword: vi.fn(async () => false) })
		await expect(
			readDatabase({ searchParams: params(), credentials: NO_CREDENTIALS, contentLength: null }, d),
		).rejects.toThrow("Invalid password")
		expect(d.exportSections).not.toHaveBeenCalled()
	})

	it("lets a CLI request through untouched", async () => {
		const d = deps()
		await readDatabase(
			{ searchParams: params(), credentials: { ...NO_CREDENTIALS, cli: true }, contentLength: null },
			d,
		)
		expect(d.verifyPassword).not.toHaveBeenCalled()
		expect(d.exportSections).toHaveBeenCalledWith(null)
	})

	it("passes the requested sections as a list", async () => {
		const d = deps()
		await readDatabase(
			{
				searchParams: params("sections=keys,combos"),
				credentials: { ...NO_CREDENTIALS, password: "pw" },
				contentLength: null,
			},
			d,
		)
		expect(d.exportSections).toHaveBeenCalledWith(["keys", "combos"])
	})

	it("treats an empty sections list as everything, not nothing", async () => {
		const d = deps()
		await readDatabase(
			{
				searchParams: params("sections=,,"),
				credentials: { ...NO_CREDENTIALS, password: "pw" },
				contentLength: null,
			},
			d,
		)
		expect(d.exportSections).toHaveBeenCalledWith(null)
	})

	it("does not accept summary=1 as the summary exemption", async () => {
		const d = deps({ verifyPassword: vi.fn(async () => false) })
		await expect(
			readDatabase(
				{ searchParams: params("summary=1"), credentials: NO_CREDENTIALS, contentLength: null },
				d,
			),
		).rejects.toThrow("Invalid password")
	})
})

describe("writeDatabase", () => {
	const body = { password: "pw", keys: [{ id: 1 }] }

	it("strips the password out of the payload it writes", async () => {
		const d = deps()
		await writeDatabase({ body, credentials: NO_CREDENTIALS }, d)
		expect(d.importPayload).toHaveBeenCalledWith({ keys: [{ id: 1 }] })
	})

	it("accepts the password from the body, which is where the browser puts it", async () => {
		const verify = vi.fn(async (p: string | null) => p === "pw")
		const d = deps({ verifyPassword: verify })
		await writeDatabase({ body, credentials: NO_CREDENTIALS }, d)
		expect(verify).toHaveBeenCalledWith("pw")
	})

	it("refuses before touching the database", async () => {
		const d = deps({ verifyPassword: vi.fn(async () => false) })
		await expect(
			writeDatabase({ body: { password: "wrong" }, credentials: NO_CREDENTIALS }, d),
		).rejects.toThrow("Invalid password")
		expect(d.importPayload).not.toHaveBeenCalled()
	})

	it("re-applies the effects an import invalidated", async () => {
		const d = deps()
		await writeDatabase({ body, credentials: NO_CREDENTIALS }, d)
		expect(d.afterImport).toHaveBeenCalledOnce()
	})

	it("does not re-apply anything when the import failed", async () => {
		const d = deps({
			importPayload: vi.fn(async () => {
				throw new Error("disk full")
			}),
		})
		await expect(writeDatabase({ body, credentials: NO_CREDENTIALS }, d)).rejects.toThrow("disk full")
		expect(d.afterImport).not.toHaveBeenCalled()
	})

	it("requires the password even when the body is otherwise empty", async () => {
		const d = deps({ verifyPassword: vi.fn(async () => false) })
		await expect(writeDatabase({ body: {}, credentials: NO_CREDENTIALS }, d)).rejects.toThrow(
			"Invalid password",
		)
	})

	it("lets a CLI import through without a password", async () => {
		const d = deps()
		await writeDatabase({ body: { keys: [] }, credentials: { ...NO_CREDENTIALS, cli: true } }, d)
		expect(d.verifyPassword).not.toHaveBeenCalled()
		expect(d.importPayload).toHaveBeenCalledWith({ keys: [] })
	})
})

describe("startDatabaseJob", () => {
	const body = { password: "pw", keys: [] }

	it("answers a poll token", async () => {
		const result = await startDatabaseJob(
			{ body, credentials: NO_CREDENTIALS, contentLength: "10" },
			deps(),
		)
		expect(result).toEqual({ jobId: "job-1", status: "queued", pollToken: "tok" })
	})

	it("refuses an oversized body before authenticating it", async () => {
		const d = deps()
		await expect(
			startDatabaseJob(
				{ body, credentials: NO_CREDENTIALS, contentLength: String(MAX_IMPORT_BYTES + 1) },
				d,
			),
		).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" })
		expect(d.startJob).not.toHaveBeenCalled()
	})

	it("refuses a bad password without starting a job", async () => {
		const d = deps({ verifyPassword: vi.fn(async () => false) })
		await expect(
			startDatabaseJob({ body, credentials: NO_CREDENTIALS, contentLength: "10" }, d),
		).rejects.toThrow("Invalid password")
		expect(d.startJob).not.toHaveBeenCalled()
	})

	it("strips the password before starting the job", async () => {
		const d = deps()
		await startDatabaseJob({ body, credentials: NO_CREDENTIALS, contentLength: "10" }, d)
		expect(d.startJob).toHaveBeenCalledWith({ keys: [] })
	})
})

describe("readDatabaseJob", () => {
	const job = { status: "running", progress: { percent: 40, currentSection: "keys" } }

	it("refuses a missing id before looking anything up", async () => {
		const d = deps()
		await expect(readDatabaseJob({ jobId: "", credentials: NO_CREDENTIALS }, d)).rejects.toThrow(
			"Missing job id",
		)
		expect(d.findJob).not.toHaveBeenCalled()
	})

	it("answers not-found for an unknown job", async () => {
		await expect(
			readDatabaseJob({ jobId: "nope", credentials: NO_CREDENTIALS }, deps()),
		).rejects.toMatchObject({ code: "NOT_FOUND" })
	})

	it("admits a poll token without asking for the password", async () => {
		const d = deps({ findJob: vi.fn(() => job) })
		await readDatabaseJob({ jobId: "j", credentials: { ...NO_CREDENTIALS, pollToken: "tok" } }, d)
		expect(d.verifyPassword).not.toHaveBeenCalled()
	})

	it("falls back to the password when the token is wrong", async () => {
		const d = deps({
			findJob: vi.fn(() => job),
			verifyPollToken: vi.fn(() => false),
			verifyPassword: vi.fn(async () => true),
		})
		await readDatabaseJob(
			{ jobId: "j", credentials: { ...NO_CREDENTIALS, pollToken: "bad", password: "pw" } },
			d,
		)
		expect(d.verifyPassword).toHaveBeenCalledWith("pw")
	})

	it("freezes a poll out when neither credential holds", async () => {
		const d = deps({
			findJob: vi.fn(() => job),
			verifyPollToken: vi.fn(() => false),
			verifyPassword: vi.fn(async () => false),
		})
		await expect(
			readDatabaseJob({ jobId: "j", credentials: { ...NO_CREDENTIALS, pollToken: "bad" } }, d),
		).rejects.toThrow("Invalid password")
	})

	it("does not call the token check with an empty token", async () => {
		const verifyToken = vi.fn(() => true)
		const d = deps({
			findJob: vi.fn(() => job),
			verifyPollToken: verifyToken,
			verifyPassword: vi.fn(async () => false),
		})
		await expect(readDatabaseJob({ jobId: "j", credentials: NO_CREDENTIALS }, d)).rejects.toThrow()
		expect(verifyToken).not.toHaveBeenCalled()
	})

	it("answers the progress, not the whole job", async () => {
		const d = deps({ findJob: vi.fn(() => job) })
		expect(
			await readDatabaseJob({ jobId: "j", credentials: { ...NO_CREDENTIALS, cli: true } }, d),
		).toEqual({ status: "running", progress: 40, section: "keys", message: null })
	})
})
