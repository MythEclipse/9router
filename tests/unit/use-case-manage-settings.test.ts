import { describe, expect, it, vi } from "vitest"
import {
	makeManageSettings,
	type SettingsDependencies,
} from "../../apps/api/src/application/settings/manage-settings.ts"

function harness(
	options: {
		stored?: Record<string, unknown>
		matches?: boolean
		snapshotFails?: boolean
		flags?: { requestLogs: boolean; translator: boolean }
	} = {},
) {
	let stored = options.stored ?? { theme: "dark", comboStrategy: "sticky" }
	const write: ReturnType<typeof vi.fn> = vi.fn(async (fields: Record<string, unknown>) => {
		stored = { ...stored, ...fields }
	})
	const snapshot = options.snapshotFails
		? vi.fn(async (_before: Record<string, unknown>, _reason: string) => {
				throw new Error("history is down")
			})
		: vi.fn(async (_before: Record<string, unknown>, _reason: string) => {})
	const effects: SettingsDependencies["effects"] & {
		applyOutboundProxy: ReturnType<typeof vi.fn>
		resetComboRotation: ReturnType<typeof vi.fn>
		resetProxyHealth: ReturnType<typeof vi.fn>
		reconfigureAutoPing: ReturnType<typeof vi.fn>
	} = {
		applyOutboundProxy: vi.fn(),
		resetComboRotation: vi.fn(),
		resetProxyHealth: vi.fn(),
		reconfigureAutoPing: vi.fn(),
	}
	const deps: SettingsDependencies = {
		store: { read: async () => stored, update: write },
		comparePassword: vi.fn(async () => options.matches ?? true),
		hashPassword: vi.fn(async (plain: string) => `hashed(${plain})`),
		snapshot,
		effects,
		environmentFlags: () => options.flags ?? { requestLogs: true, translator: false },
		logWarning: vi.fn(),
	}
	return { settings: makeManageSettings(deps), deps, write, snapshot, effects }
}

describe("manageSettings.read", () => {
	it("never sends the password hash", async () => {
		const { settings } = harness({ stored: { password: "hash", theme: "dark" } })
		const result = await settings.read()
		expect(result).not.toHaveProperty("password")
		expect(result.hasPassword).toBe(true)
	})

	it("never sends the OIDC client secret, but says whether it is configured", async () => {
		const { settings } = harness({
			stored: {
				oidcIssuerUrl: "https://idp",
				oidcClientId: "id",
				oidcClientSecret: "secret",
			},
		})
		const result = await settings.read()
		expect(result).not.toHaveProperty("oidcClientSecret")
		expect(result.oidcConfigured).toBe(true)
	})

	it("reports the two environment flags the dashboard cannot otherwise see", async () => {
		const { settings } = harness({ flags: { requestLogs: false, translator: true } })
		expect(await settings.read()).toMatchObject({
			enableRequestLogs: false,
			enableTranslator: true,
		})
	})
})

describe("manageSettings.write — protected keys", () => {
	it("never writes a password sent outside the newPassword flow", async () => {
		const { settings, write } = harness()
		await settings.write({ body: { password: "planted", theme: "light" } })
		expect(write).toHaveBeenCalledWith({ theme: "light" })
	})

	it("keeps the planted hash out of the before-image", async () => {
		const { settings, snapshot } = harness()
		await settings.write({ body: { password: "planted" } })
		const [before] = snapshot.mock.calls[0]
		expect(before).not.toHaveProperty("password")
	})
})

describe("manageSettings.write — the admin-only theme", () => {
	it("refuses a key-signed session with a message naming the field", async () => {
		const { settings, write } = harness()
		await expect(settings.write({ body: { theme: "light" }, role: "apikey" })).rejects.toThrow(
			/"theme" is an administrator setting/,
		)
		expect(write).not.toHaveBeenCalled()
	})

	it("lets an administrator write it", async () => {
		const { settings, write } = harness()
		await settings.write({ body: { theme: "light" }, role: "admin" })
		expect(write).toHaveBeenCalledWith({ theme: "light" })
	})

	it("does not refuse a form that sends the field untouched", async () => {
		const { settings, write } = harness()
		await settings.write({ body: { theme: undefined, comboStrategy: "x" }, role: "apikey" })
		expect(write).toHaveBeenCalledWith({ comboStrategy: "x" })
	})
})

describe("manageSettings.write — the password", () => {
	it("hashes a new password and drops the plaintext", async () => {
		const { settings, write } = harness({
			stored: { password: "old-hash" },
			matches: true,
		})
		await settings.write({
			body: { newPassword: "sekrit", currentPassword: "given" },
			role: "admin",
		})
		expect(write).toHaveBeenCalledWith({ password: "hashed(sekrit)" })
	})

	it("refuses a wrong current password and writes nothing", async () => {
		const { settings, write } = harness({ stored: { password: "old-hash" }, matches: false })
		await expect(
			settings.write({ body: { newPassword: "x", currentPassword: "wrong" } }),
		).rejects.toThrow("Invalid current password")
		expect(write).not.toHaveBeenCalled()
	})

	it("refuses a missing current password before hashing anything", async () => {
		const { settings, deps } = harness({ stored: { password: "old-hash" } })
		await expect(settings.write({ body: { newPassword: "x" } })).rejects.toThrow(
			"Current password required",
		)
		expect(deps.hashPassword).not.toHaveBeenCalled()
	})

	it("sets the first password with no comparison at all", async () => {
		const { settings, deps, write } = harness({ stored: {} })
		await settings.write({ body: { newPassword: "first" } })
		expect(deps.comparePassword).not.toHaveBeenCalled()
		expect(write).toHaveBeenCalledWith({ password: "hashed(first)" })
	})
})

describe("manageSettings.write — the OIDC secret", () => {
	it("leaves the stored secret alone when the field arrives blank", async () => {
		const { settings, write } = harness()
		await settings.write({ body: { oidcClientSecret: "", oidcClientId: "id" } })
		expect(write).toHaveBeenCalledWith({ oidcClientId: "id" })
	})

	it("writes a real secret", async () => {
		const { settings, write } = harness()
		await settings.write({ body: { oidcClientSecret: "real" } })
		expect(write).toHaveBeenCalledWith({ oidcClientSecret: "real" })
	})
})

describe("manageSettings.write — the before-image", () => {
	it("records the state it is about to replace", async () => {
		const { settings, snapshot } = harness({ stored: { theme: "dark" } })
		await settings.write({ body: { theme: "light" }, role: "admin" })
		expect(snapshot).toHaveBeenCalledWith({ theme: "dark" }, "theme")
	})

	it("names the changed fields as the reason", async () => {
		const { settings, snapshot } = harness()
		await settings.write({ body: { comboStrategy: "x", outboundProxyUrl: "y" } })
		expect(snapshot.mock.calls[0][1]).toBe("comboStrategy, outboundProxyUrl")
	})

	it("does not fail the change when history is down", async () => {
		const { settings, write } = harness({ snapshotFails: true })
		await expect(settings.write({ body: { comboStrategy: "x" } })).resolves.toBeTruthy()
		expect(write).toHaveBeenCalled()
	})
})

describe("manageSettings.write — what the write owes the process", () => {
	it("owes nothing for an unrelated change", async () => {
		const { settings, effects } = harness()
		await settings.write({ body: { comboStrategy: "x" } })
		const { resetComboRotation, ...untouched } = effects
		expect(resetComboRotation).toHaveBeenCalled()
		for (const spy of Object.values(untouched)) expect(spy).not.toHaveBeenCalled()
	})

	it("applies the outbound proxy with the new settings", async () => {
		const { settings, effects } = harness()
		await settings.write({ body: { outboundProxyUrl: "http://proxy" } })
		expect(effects.applyOutboundProxy).toHaveBeenCalledWith(
			expect.objectContaining({ outboundProxyUrl: "http://proxy" }),
		)
	})

	it("resets proxy health when the provider strategies change", async () => {
		const { settings, effects } = harness()
		await settings.write({ body: { providerStrategies: { xai: "sticky" } } })
		expect(effects.resetProxyHealth).toHaveBeenCalledOnce()
	})

	it("reconfigures auto-ping after the write, not before", async () => {
		const { settings, effects, write } = harness()
		const order: string[] = []
		write.mockImplementationOnce(async () => {
			order.push("write")
		})
		effects.reconfigureAutoPing.mockImplementationOnce(() => order.push("autoping"))
		await settings.write({ body: { claudeAutoPing: true } })
		expect(order).toEqual(["write", "autoping"])
	})
})

describe("manageSettings.write — the answer", () => {
	it("answers with the safe settings, never the secrets it just wrote", async () => {
		const { settings } = harness({ stored: { password: "old-hash" }, matches: true })
		const result = await settings.write({
			body: { newPassword: "x", currentPassword: "y", oidcClientSecret: "s3cret" },
			role: "admin",
		})
		expect(result).not.toHaveProperty("password")
		expect(result).not.toHaveProperty("oidcClientSecret")
		expect(result.hasPassword).toBe(true)
	})
})
