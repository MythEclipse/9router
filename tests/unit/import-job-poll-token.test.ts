import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(__dirname, "../..")
const read = (p: string) => readFileSync(resolve(root, p), "utf8")

/**
 * The poll credential a restore hands its client.
 *
 * The route files are thin delegations now, so these assertions follow the behaviour
 * to where it lives: the token is *issued* in `packages/db`, *returned* by the
 * use-case, and *checked before the password* by the use-case too. Asserting the
 * shape of a route body that no longer holds logic would only pin the delegation.
 */
describe("import job poll credential", () => {
	it("createImportJob actually issues a token", () => {
		const lib = read("packages/db/src/importJobs.ts")
		expect(lib).toContain("issuePollToken()")
		expect(lib).toContain("pollTokenHash: hash")
		expect(lib).toContain("pollToken: token")
	})

	it("the job creation use-case returns the token to the client", () => {
		const useCase = read("apps/api/src/application/settings/manage-database.ts")
		// The token must leave the server, otherwise the client has nothing to poll
		// with and falls back to the password header against a settings row the
		// import is replacing.
		expect(useCase).toMatch(/pollToken: job\.pollToken/)
	})

	it("the job creation route answers 202 with what the use-case returned", () => {
		const route = read("apps/web/src/app/api/settings/database/jobs/route.ts")
		expect(route).toContain("startJob")
		expect(route).toMatch(/status:\s*202/)
	})

	it("the poll use-case checks the token before the password fallback", () => {
		const useCase = read("apps/api/src/application/settings/manage-database.ts")
		const tokenIdx = useCase.indexOf("verifyPollToken(")
		const passIdx = useCase.indexOf("verifyPassword(input.credentials.password)")
		expect(tokenIdx).toBeGreaterThan(-1)
		expect(passIdx).toBeGreaterThan(tokenIdx)
	})

	it("the digest survives completion so the last poll still authenticates", () => {
		const lib = read("packages/db/src/importJobs.ts")
		// Nulling the digest at done/error made the completion poll fall back to the
		// password header the token-based client never sends: 401 over a done
		// restore. The digest now dies with the job record via RESULT_TTL cleanup.
		expect(lib).not.toContain("pollTokenHash = null")
	})

	it("the client forwards the token from the POST response", () => {
		const page = read("apps/web/src/app/(dashboard)/dashboard/profile/page.tsx")
		expect(page).toContain("jobData.pollToken")
		expect(page).toContain('"x-9r-poll-token"')
	})
})
