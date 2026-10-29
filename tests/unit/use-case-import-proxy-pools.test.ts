import { describe, expect, it, vi } from "vitest"
import {
	cancelProxyImport,
	type ImportJobDeps,
	type ImportJobView,
	readProxyImportJobs,
	startProxyImport,
} from "../../apps/api/src/application/proxy-pools/import-proxy-pools.ts"

const JOB: ImportJobView = {
	id: "job-1",
	status: "running",
	progress: 0,
	message: "0/2 proxies",
	counts: { created: 0, skipped: 0, failed: 0, processed: 0, total: 2 },
	error: null,
	cancelRequested: false,
	createdAt: "2026-10-29T00:00:00.000Z",
	updatedAt: "2026-10-29T00:00:00.000Z",
}

function deps(overrides: Partial<ImportJobDeps> = {}): ImportJobDeps {
	return {
		create: vi.fn(() => ({ jobId: "job-1", status: "running", total: 2 })),
		find: vi.fn(() => JOB),
		list: vi.fn(() => [JOB]),
		cancel: vi.fn(() => true),
		...overrides,
	}
}

function query(entries: Record<string, string> = {}): URLSearchParams {
	return new URLSearchParams(entries)
}

describe("startProxyImport", () => {
	it("starts a job over the rows and reports where to poll", () => {
		const d = deps()
		const answer = startProxyImport(
			{
				entries: [
					{ name: "a", proxyUrl: "http://h:1" },
					{ name: "b", proxyUrl: "http://h:2" },
				],
			},
			d,
		)
		expect(answer).toMatchObject({ jobId: "job-1", status: "running", total: 2 })
		expect(answer.pollMs).toBeGreaterThan(0)
		expect(d.create).toHaveBeenCalledWith([
			{ name: "a", proxyUrl: "http://h:1" },
			{ name: "b", proxyUrl: "http://h:2" },
		])
	})

	it("refuses a bad row before starting anything", () => {
		const d = deps()
		expect(() => startProxyImport({ entries: [{ name: "a", proxyUrl: "nope" }] }, d)).toThrow(
			/Invalid entries/,
		)
		expect(d.create).not.toHaveBeenCalled()
	})

	it("numbers the row the operator sees in the pasted list", () => {
		const d = deps()
		expect(() =>
			startProxyImport(
				{
					entries: [
						{ name: "a", proxyUrl: "http://h:1" },
						{ name: "", proxyUrl: "http://h:2" },
					],
				},
				d,
			),
		).toThrow(/Entry 2/)
	})

	it("calls an empty list empty rather than invalid", () => {
		const d = deps()
		expect(() => startProxyImport({ entries: [] }, d)).toThrow("Nothing to import")
	})

	it("treats a body with no entries as empty", () => {
		const d = deps()
		expect(() => startProxyImport({}, d)).toThrow("Nothing to import")
	})
})

describe("readProxyImportJobs", () => {
	it("returns the recent page when no id is given", () => {
		const d = deps()
		const answer = readProxyImportJobs(query(), d)
		expect(answer).toEqual({ jobs: [JOB] })
		expect(d.find).not.toHaveBeenCalled()
	})

	it("pages the recent list, because the screen shows a page not a history", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ ...JOB, id: `job-${i}` }))
		const answer = readProxyImportJobs(query(), deps({ list: () => many }))
		expect("jobs" in answer && answer.jobs).toHaveLength(10)
	})

	it("returns one job by id", () => {
		expect(readProxyImportJobs(query({ id: "job-1" }), deps())).toEqual({ job: JOB })
	})

	it("refuses an unknown id with not-found rather than an empty page", () => {
		const d = deps({ find: () => null })
		expect(() => readProxyImportJobs(query({ id: "gone" }), d)).toThrow("Job not found")
	})
})

describe("cancelProxyImport", () => {
	it("asks the job to stop", () => {
		const d = deps()
		expect(cancelProxyImport(query({ id: "job-1" }), d)).toEqual({ ok: true })
		expect(d.cancel).toHaveBeenCalledWith("job-1")
	})

	it("refuses a request with no id", () => {
		expect(() => cancelProxyImport(query(), deps())).toThrow("Missing job id")
	})

	it("refuses an id the store does not know", () => {
		const d = deps({ cancel: () => false })
		expect(() => cancelProxyImport(query({ id: "gone" }), d)).toThrow("Job not found")
	})
})
