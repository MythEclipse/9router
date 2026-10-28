import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
	buildComboIndex,
	buildStudioTargetMap,
	findStudioCycle,
	studioReachesCombo,
} from "@/shared/utils/studioComboGuard.js"

// Custom model (studio) pointing at a combo: valid targets pass, cycles fail,
// and old provider/model backups keep loading unchanged.
const originalDataDir = process.env.DATA_DIR

let ctx

beforeAll(async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-studio-combo-"))
	process.env.DATA_DIR = tempDir
	vi.resetModules()
	const db = await import("@9router/db")
	const editor = await import("@9router/db/repos/modelEditorRepo")
	ctx = { db, editor, tempDir }
})

beforeEach(async () => {
	const comboName = `plain-mix-${randomUUID()}`
	const prefix = `ossnode-${randomUUID()}`
	const node = await ctx.db.createProviderNode({
		name: `Oss Node ${randomUUID()}`,
		type: "openai-compatible",
		prefix,
		apiType: "chat",
		baseUrl: "https://upstream.test/v1",
	})
	await ctx.db.createCombo({ name: comboName, models: [`${prefix}/gpt-oss-120b`] })
	ctx = { ...ctx, nodeId: node.id, prefix, comboName }
}, 60_000)

afterAll(() => {
	fs.rmSync(ctx.tempDir, { recursive: true, force: true })
	if (originalDataDir === undefined) delete process.env.DATA_DIR
	else process.env.DATA_DIR = originalDataDir
})

async function addStudio(callName, targetModel) {
	await ctx.editor.setStudioModel({
		callName,
		displayName: "",
		targetModel,
		targetLabel: targetModel,
		contextWindow: 0,
		systemPrompt: "",
	})
}

describe("studio combo guard unit", () => {
	it("accepts a combo that does not reference the studio", () => {
		const combos = buildComboIndex([{ name: "mix", models: ["ossnode/a"] }])
		const targets = buildStudioTargetMap({ workhorse: "mix" })
		expect(
			findStudioCycle({
				callName: "workhorse",
				comboName: "mix",
				combosByName: combos,
				studioTargets: targets,
			}),
		).toBeNull()
	})

	it("rejects a combo that directly contains the studio name", () => {
		const combos = buildComboIndex([{ name: "mix", models: ["workhorse"] }])
		const targets = buildStudioTargetMap({})
		const chain = findStudioCycle({
			callName: "workhorse",
			comboName: "mix",
			combosByName: combos,
			studioTargets: targets,
		})
		expect(chain).toEqual(["mix", "workhorse"])
	})

	it("rejects an indirect cycle through a nested combo and chained studio", () => {
		const combos = buildComboIndex([
			{ name: "outer", models: ["inner"] },
			{ name: "inner", models: ["helper"] },
		])
		const targets = buildStudioTargetMap({ helper: "outer" })
		const chain = findStudioCycle({
			callName: "workhorse",
			comboName: "outer",
			combosByName: combos,
			studioTargets: targets,
			extraSelfNames: [],
		})
		expect(chain).toBeNull()
		const looped = findStudioCycle({
			callName: "helper",
			comboName: "outer",
			combosByName: combos,
			studioTargets: buildStudioTargetMap({}),
		})
		expect(looped).toEqual(["outer", "inner", "helper"])
	})

	it("detects a studio reaching back into the combo being saved", () => {
		const combos = buildComboIndex([{ name: "mix", models: ["workhorse"] }])
		const targets = buildStudioTargetMap({ workhorse: "mix" })
		expect(
			studioReachesCombo({
				studioName: "workhorse",
				comboName: "mix",
				combosByName: combos,
				studioTargets: targets,
			}),
		).toEqual(["workhorse", "mix"])
	})

	it("ignores provider/model members that cannot form a cycle", () => {
		const combos = buildComboIndex([{ name: "mix", models: ["ossnode/a", "openai/gpt-x"] }])
		const targets = buildStudioTargetMap({})
		expect(
			findStudioCycle({
				callName: "workhorse",
				comboName: "mix",
				combosByName: combos,
				studioTargets: targets,
			}),
		).toBeNull()
	})
})

describe("studio to combo resolution", () => {
	it("stores a combo target and resolves it as a combo at runtime", async () => {
		await addStudio("workhorse", ctx.comboName)
		const stored = await ctx.editor.getStudioModel("workhorse")
		expect(stored.targetModel).toBe(ctx.comboName)
		expect(stored.isComboTarget).toBe(true)
		const { getModelInfo } = await import("@/sse/services/model.js")
		expect(await getModelInfo("workhorse")).toEqual({ provider: null, model: ctx.comboName })
	})

	it("keeps resolving a legacy provider target unchanged", async () => {
		const callName = `legacy-name-${randomUUID()}`
		await addStudio(callName, `${ctx.prefix}/gpt-oss-120b`)
		const { getModelInfo } = await import("@/sse/services/model.js")
		expect(await getModelInfo(callName)).toEqual({ provider: ctx.nodeId, model: "gpt-oss-120b" })
	})

	it("keeps an old provider/model backup importable", async () => {
		const exported = await ctx.db.exportDb()
		expect(exported.modelOverrides).toBeDefined()
		const callName = `legacy-name-${randomUUID()}`
		await addStudio(callName, `${ctx.prefix}/gpt-oss-120b`)
		const payload = await ctx.db.exportDb()
		const legacyPayload = JSON.parse(JSON.stringify(payload))
		await ctx.db.importDb(legacyPayload)
		const restored = await ctx.editor.getStudioModel(callName)
		expect(restored.targetModel).toBe(`${ctx.prefix}/gpt-oss-120b`)
		expect(restored.isComboTarget).not.toBe(true)
	})
})
