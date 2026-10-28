import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
	labelForResolved,
	labelForRow,
	MODEL_NAME_COLUMNS,
	resolvedModelOf,
} from "../../src/lib/db/helpers/modelLabel"

/**
 * A usage row carries two names: `model` is what the caller asked for (a combo
 * survives there) and `meta.resolvedModel` is what actually served it. Every
 * reader has to make the same two decisions — which name to show, and whether
 * that name was an alias — so the decision lives in one module.
 *
 * It did not, once. Four readers each resolved it themselves; one forgot to
 * select `meta` at all, so it labelled rows with the combo and the dashboard
 * flipped between the two names on every request. These tests pin the contract
 * and fail if the duplicated resolution comes back.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const repo = readFileSync(join(REPO_ROOT, "src/lib/db/repos/usageRepo.ts"), "utf8")

describe("modelLabel", () => {
	it("reads the real model out of the meta blob", () => {
		expect(resolvedModelOf('{"resolvedModel":"deepseek-v4.1-flash"}')).toBe("deepseek-v4.1-flash")
	})

	it("treats a missing, empty, or malformed meta as 'no alias'", () => {
		for (const meta of [
			null,
			undefined,
			"",
			"{}",
			"not json",
			'{"resolvedModel":""}',
			'{"resolvedModel":42}',
		]) {
			expect(resolvedModelOf(meta)).toBeNull()
		}
	})

	it("leads with the real model and keeps the requested name as the alias", () => {
		expect(labelForRow("claude-opus-5-5", '{"resolvedModel":"deepseek-v4.1-flash"}')).toEqual({
			display: "deepseek-v4.1-flash",
			alias: "claude-opus-5-5",
		})
	})

	it("falls back to the stored name when the row was never aliased", () => {
		expect(labelForRow("gemini-3.5-flash-lite", "{}")).toEqual({
			display: "gemini-3.5-flash-lite",
			alias: undefined,
		})
	})

	it("drops an alias that would just repeat the display name", () => {
		expect(labelForRow("same", '{"resolvedModel":"same"}')).toEqual({
			display: "same",
			alias: undefined,
		})
	})

	it("labels a ring entry, whose pair is fields rather than a meta blob", () => {
		expect(labelForResolved("text", "gemini-3.1-flash-lite")).toEqual({
			display: "gemini-3.1-flash-lite",
			alias: "text",
		})
		expect(labelForResolved("text", null)).toEqual({ display: "text", alias: undefined })
	})

	it("names the columns a reader has to select", () => {
		expect(MODEL_NAME_COLUMNS).toBe("model, meta")
	})
})

describe("alias resolution is not duplicated across readers", () => {
	it("has no reader parsing resolvedModel out of meta by hand", () => {
		// The exact expression that was copy-pasted into four readers.
		expect(repo).not.toMatch(/\|\|\s*\{\}\)\.resolvedModel/)
		expect(repo).not.toMatch(/parseJson<Record<string, unknown>>\(r\.meta/)
	})

	it("resolves every row through the shared helper", () => {
		const calls = repo.match(/resolvedModelOf\(|labelForRow\(|labelForResolved\(/g) ?? []
		expect(calls.length).toBeGreaterThanOrEqual(6)
	})
})
