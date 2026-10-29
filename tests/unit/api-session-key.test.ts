import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { getDataDir } from "@9router/db/shared/dataDir"
import { describe, expect, it } from "vitest"
import {
	AUTH_TOKEN_COOKIE,
	readCookie,
	sessionFromClaims,
} from "../../apps/api/src/infrastructure/session-from-cookie.ts"

/**
 * The signing key is the whole contract between `apps/web` and the API.
 *
 * `main.ts` used `env.DATA_DIR ?? process.cwd()` as the directory to load it from.
 * That is wrong whenever the server is started from anywhere but the dashboard's
 * directory — which is always, since the entry point lives in `apps/api`. The
 * process then *generated a second key* and rejected every cookie `apps/web` had
 * signed. Nothing failed loudly: `/health` answered, the port was open, and every
 * authenticated call was a 401.
 *
 * `getDataDir()` is the shared rule the database already uses, so pin it here.
 */
describe("the API reads the same signing key as the dashboard", () => {
	it("falls back to the dashboard's default data directory, not the cwd", () => {
		const configured = process.env.DATA_DIR
		delete process.env.DATA_DIR
		try {
			// `~/.9router` — the same directory `apps/web` writes `jwt-secret` into.
			expect(getDataDir()).toMatch(/\.9router$/)
			// The bug this pins: an unset DATA_DIR must never resolve to the repo
			// root or `apps/api`, where a fresh key would be minted.
			expect(getDataDir()).not.toBe(process.cwd())
		} finally {
			if (configured !== undefined) process.env.DATA_DIR = configured
		}
	})

	it("uses DATA_DIR when it is writable", () => {
		const configured = process.env.DATA_DIR
		// A real, writable directory under the OS temp root: `getDataDir` creates it
		// with `mkdir` and falls back to `~/.9router` when that fails, so a made-up
		// path like `/var/lib/...` would legitimately answer with the default.
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "9router-datadir-"))
		process.env.DATA_DIR = temp
		try {
			expect(getDataDir()).toBe(temp)
		} finally {
			fs.rmSync(temp, { recursive: true, force: true })
			if (configured === undefined) delete process.env.DATA_DIR
			else process.env.DATA_DIR = configured
		}
	})
})

describe("reading the session cookie off a raw header", () => {
	it("reads the value verbatim, including JWT padding", () => {
		expect(readCookie(`${AUTH_TOKEN_COOKIE}=abc.def.ghi`, AUTH_TOKEN_COOKIE)).toBe("abc.def.ghi")
	})

	it("finds the cookie among others and ignores a lookalike name", () => {
		const header = "theme=dark; auth_token=xyz; not_auth_token=nope"
		expect(readCookie(header, AUTH_TOKEN_COOKIE)).toBe("xyz")
	})

	it("answers null for a missing or empty cookie", () => {
		expect(readCookie(null, AUTH_TOKEN_COOKIE)).toBeNull()
		expect(readCookie("theme=dark", AUTH_TOKEN_COOKIE)).toBeNull()
		expect(readCookie(`${AUTH_TOKEN_COOKIE}=`, AUTH_TOKEN_COOKIE)).toBeNull()
	})
})

describe("claims that count as a session", () => {
	it("needs a userId — a valid signature alone names nobody", () => {
		expect(sessionFromClaims({ email: "a@b.c" })).toBeNull()
		expect(sessionFromClaims({ userId: "   " })).toBeNull()
	})

	it("falls the email back to the user id rather than rendering undefined", () => {
		expect(sessionFromClaims({ userId: "owner" })).toMatchObject({
			userId: "owner",
			email: "owner",
		})
	})
})
