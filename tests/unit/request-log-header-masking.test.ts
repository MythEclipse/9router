// ENABLE_REQUEST_LOGS writes request/response headers to disk under logs/.
// logTargetRequest receives the headers the gateway sends UPSTREAM, so those
// files hold the provider's Authorization / x-api-key and any Cookie the lane
// needs. maskSensitiveHeaders used to be disabled (its body returned a shallow
// copy with the masking loop commented out), so enabling debug logging wrote
// working credentials for every connected provider into a plain-text tree.

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const SECRET_AUTH = "Bearer TOPSECRETVALUEAAAAAAAAAAAAAAAA"
const SECRET_XKEY = "sk-TOPSECRETVALUEBBBBBBBBBBBBBBBB"
const SECRET_COOKIE = "sid=TOPSECRETVALUECCCCCCCCCCCCCCCC"
const SECRET_SETCOOKIE = "jwt=TOPSECRETVALUEDDDDDDDDDDDDDDDD"

let createRequestLogger
let sessionPath
let cwdBefore
let tempCwd

beforeAll(async () => {
	process.env.ENABLE_REQUEST_LOGS = "true"
	// createRequestLogger writes under process.cwd()/logs — run inside a temp cwd
	// so the suite never drops files into the repo.
	cwdBefore = process.cwd()
	tempCwd = mkdtempSync(path.join(tmpdir(), "9r-reqlog-"))
	process.chdir(tempCwd)
	;({ createRequestLogger } = await import("../../open-sse/utils/requestLogger.js"))
	const logger = await createRequestLogger("openai", "openai", "mask-probe")
	sessionPath = logger.sessionPath
	logger.logTargetRequest(
		"https://upstream.example/v1/chat",
		{
			"Content-Type": "application/json",
			Authorization: SECRET_AUTH,
			"x-api-key": SECRET_XKEY,
			Cookie: SECRET_COOKIE,
		},
		{ model: "mask-probe" },
	)
	logger.logProviderResponse(
		200,
		"OK",
		{
			"content-type": "application/json",
			"set-cookie": SECRET_SETCOOKIE,
		},
		{},
	)
})

afterAll(() => {
	process.chdir(cwdBefore)
	try {
		rmSync(tempCwd, { recursive: true, force: true })
	} catch {}
	delete process.env.ENABLE_REQUEST_LOGS
})

function readLog(name) {
	return readFileSync(path.join(sessionPath, name), "utf8")
}

describe("debug request logging never persists credentials", () => {
	it("masked every credential header in the upstream request log", () => {
		const raw = readLog("4_req_target.json")
		expect(raw).not.toContain("TOPSECRETVALUEAAAA")
		expect(raw).not.toContain("TOPSECRETVALUEBBBB")
		expect(raw).not.toContain("TOPSECRETVALUECCCC")
		expect(raw).toContain("...")
	})

	it("masked set-cookie in the provider response log", () => {
		const raw = readLog("5_res_provider.json")
		expect(raw).not.toContain("TOPSECRETVALUEDDDD")
	})

	it("kept non-credential headers readable for diagnosis", () => {
		// Masking must not destroy the reason the operator turned logging on:
		// content-type / anthropic-beta are what you read when a lane misbehaves.
		const parsed = JSON.parse(readLog("4_req_target.json"))
		expect(parsed.headers["Content-Type"]).toBe("application/json")
		expect(parsed.headers.Authorization).not.toBe(SECRET_AUTH)
		expect(parsed.headers.Authorization.startsWith("Bearer")).toBe(true)
	})
})
