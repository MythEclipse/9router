import { describe, expect, test } from "bun:test"
import type { CodexProfilesPort } from "../../apps/api/src/application/codex-profiles/manage-codex-profiles.ts"
import {
	deleteCodexProfile,
	listCodexProfiles,
	writeCodexProfile,
} from "../../apps/api/src/application/codex-profiles/manage-codex-profiles.ts"

/**
 * The three tolerances worth testing are all "a bad day" paths, which is why the port exists:
 * a missing directory, an unreadable file, and a delete of something that is not there. Each
 * one has a different right answer, and none of them can be reached through the filesystem
 * without setting up a home directory that half-fails.
 */

const fake = (init: {
	files?: Map<string, string> | null
	unreadable?: string[]
	failList?: boolean
	failWrite?: boolean
	failRemove?: boolean
}): CodexProfilesPort & { written: Map<string, string> } => {
	const written = new Map(init.files ?? [])
	return {
		written,
		listFiles: async () => {
			if (init.failList) throw new Error("EACCES: permission denied")
			if (init.files === null) return null
			return [...written.keys()]
		},
		readFile: async (file) => {
			if (init.unreadable?.includes(file)) return null
			return written.get(file) ?? null
		},
		writeFile: async (file, content) => {
			if (init.failWrite) throw new Error("ENOSPC: no space left")
			written.set(file, content)
		},
		removeFile: async (file) => {
			if (init.failRemove) throw new Error("EPERM: operation not permitted")
			return written.delete(file)
		},
	}
}

describe("listing codex profiles", () => {
	test("a missing ~/.codex is an empty list, not an error", async () => {
		const answer = await listCodexProfiles(fake({ files: null }))
		expect(answer.status).toBe(200)
		expect(answer.body).toEqual({ profiles: [] })
	})

	test("an unreadable directory is a 500, because retrying might work", async () => {
		const answer = await listCodexProfiles(fake({ failList: true }))
		expect(answer.status).toBe(500)
		expect(answer.body.error).toBe("EACCES: permission denied")
	})

	test("only .config.toml files are profiles", async () => {
		const answer = await listCodexProfiles(
			fake({
				files: new Map([
					["fast.config.toml", 'model = "gpt-5"\n'],
					["notes.md", "ignore me"],
					["weird.txt", "ignore me too"],
				]),
			}),
		)
		expect(answer.body.profiles).toEqual([{ name: "fast", model: "gpt-5", command: "codex -p fast" }])
	})

	test("the base config.toml is not listed as a profile called config", async () => {
		const answer = await listCodexProfiles(
			fake({ files: new Map([["config.toml", 'model = "base"\n']]) }),
		)
		expect(answer.body.profiles).toEqual([])
	})

	test("a profile whose file cannot be read is still listed, with no model", async () => {
		const answer = await listCodexProfiles(
			fake({
				files: new Map([["locked.config.toml", 'model = "gpt-5"\n']]),
				unreadable: ["locked.config.toml"],
			}),
		)
		expect(answer.body.profiles).toEqual([{ name: "locked", model: "", command: "codex -p locked" }])
	})

	test("a hand-edited single-quoted model is still read", async () => {
		const answer = await listCodexProfiles(
			fake({ files: new Map([["odd.config.toml", "model = 'gpt-5-mini'\n"]]) }),
		)
		expect((answer.body.profiles as { model: string }[])[0].model).toBe("gpt-5-mini")
	})

	test("profiles are sorted by name so the screen does not reorder between loads", async () => {
		const answer = await listCodexProfiles(
			fake({
				files: new Map([
					["zeta.config.toml", 'model = "a"\n'],
					["alpha.config.toml", 'model = "b"\n'],
					["mike.config.toml", 'model = "c"\n'],
				]),
			}),
		)
		expect((answer.body.profiles as { name: string }[]).map((p) => p.name)).toEqual([
			"alpha",
			"mike",
			"zeta",
		])
	})
})

describe("writing a codex profile", () => {
	test("writes the TOML and reports the profile back", async () => {
		const port = fake({ files: new Map() })
		const answer = await writeCodexProfile({ name: "fast", model: "gpt-5" }, port)
		expect(answer.status).toBe(200)
		expect(answer.body).toEqual({
			success: true,
			profile: { name: "fast", model: "gpt-5", command: "codex -p fast" },
		})
		expect(port.written.get("fast.config.toml")).toContain('model = "gpt-5"')
	})

	test("the name is lowercased and trimmed before it becomes a filename", async () => {
		const port = fake({ files: new Map() })
		await writeCodexProfile({ name: "  FAST  ", model: "gpt-5" }, port)
		expect([...port.written.keys()]).toEqual(["fast.config.toml"])
	})

	test("a name with a path separator is refused before anything is written", async () => {
		const port = fake({ files: new Map() })
		const answer = await writeCodexProfile({ name: "../escape", model: "gpt-5" }, port)
		expect(answer.status).toBe(400)
		expect(port.written.size).toBe(0)
	})

	test("'config' is refused, because config.config.toml reads like the base file", async () => {
		const answer = await writeCodexProfile({ name: "config", model: "gpt-5" }, fake({}))
		expect(answer.status).toBe(400)
		expect(String(answer.body.error)).toContain("cannot be 'config'")
	})

	test("a model with a quote is refused, because it would end the TOML string", async () => {
		const port = fake({ files: new Map() })
		const answer = await writeCodexProfile({ name: "x", model: 'gpt"\nmodel_provider = "evil' }, port)
		expect(answer.status).toBe(400)
		expect(answer.body.error).toBe("Invalid model name")
		expect(port.written.size).toBe(0)
	})

	test("an empty model is refused rather than written as an empty string", async () => {
		const answer = await writeCodexProfile({ name: "x", model: "   " }, fake({}))
		expect(answer.status).toBe(400)
	})

	test("a non-string name from a JSON body is refused, not coerced", async () => {
		const answer = await writeCodexProfile({ name: 42, model: "gpt-5" }, fake({}))
		expect(answer.status).toBe(400)
	})

	test("a write that fails on disk reports the reason", async () => {
		const answer = await writeCodexProfile({ name: "x", model: "gpt-5" }, fake({ failWrite: true }))
		expect(answer.status).toBe(500)
		expect(answer.body.error).toBe("ENOSPC: no space left")
	})

	test("a null body is a 400, not a crash", async () => {
		const answer = await writeCodexProfile(null, fake({}))
		expect(answer.status).toBe(400)
	})
})

describe("deleting a codex profile", () => {
	test("removes the file and names it in the message", async () => {
		const port = fake({ files: new Map([["gone.config.toml", 'model = "x"\n']]) })
		const answer = await deleteCodexProfile({ name: "gone" }, port)
		expect(answer.status).toBe(200)
		expect(answer.body.message).toBe("Profile gone deleted")
		expect(port.written.has("gone.config.toml")).toBe(false)
	})

	test("deleting something that is not there is a 404, not a quiet success", async () => {
		const answer = await deleteCodexProfile({ name: "absent" }, fake({ files: new Map() }))
		expect(answer.status).toBe(404)
		expect(answer.body.error).toBe("Profile not found")
	})

	test("an invalid name is a 400 and never reaches the filesystem", async () => {
		let touched = false
		const port = fake({ files: new Map() })
		const answer = await deleteCodexProfile(
			{ name: "bad/name" },
			{
				...port,
				removeFile: async () => {
					touched = true
					return true
				},
			},
		)
		expect(answer.status).toBe(400)
		expect(touched).toBe(false)
	})

	test("a delete that the filesystem refuses reports the reason rather than 404", async () => {
		const answer = await deleteCodexProfile({ name: "x" }, fake({ failRemove: true }))
		expect(answer.status).toBe(500)
		expect(answer.body.error).toBe("EPERM: operation not permitted")
	})
})
