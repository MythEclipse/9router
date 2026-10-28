import { describe, expect, it } from "vitest"
import { buildServerEnv } from "../../cli/src/cli/serverEnv.ts"

describe("buildServerEnv", () => {
	const baseEnv = { PATH: "/usr/bin" }

	it("passes the port and host to the server", () => {
		const env = buildServerEnv({ baseEnv, port: 20128, host: "0.0.0.0" })

		expect(env.PORT).toBe("20128")
		expect(env.HOSTNAME).toBe("0.0.0.0")
	})

	it("keeps the inherited environment", () => {
		const env = buildServerEnv({ baseEnv, port: 20128, host: "127.0.0.1" })

		expect(env.PATH).toBe("/usr/bin")
	})
})
