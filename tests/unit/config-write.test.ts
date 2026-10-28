import { describe, expect, it } from "vitest"
import { ConfigUnreadableError, readConfigForWrite } from "@/lib/cliTools/configWrite"

/**
 * The rule under test: an absent file is a fresh start, but a file that exists and
 * cannot be parsed must stop the write. Getting this wrong loses every other setting
 * the user had, silently, on the next save.
 */
const io = (impl: (path: string) => Promise<string>) => ({
	readFile: (path: string, _enc: "utf-8") => impl(path),
})

describe("readConfigForWrite", () => {
	it("returns an empty config when the file does not exist", async () => {
		const fs = io(async () => {
			const err: any = new Error("no such file")
			err.code = "ENOENT"
			throw err
		})
		await expect(readConfigForWrite(fs, "/cfg/x.toml", JSON.parse)).resolves.toEqual({})
	})

	it("returns an empty config when a path segment is not a directory", async () => {
		const fs = io(async () => {
			const err: any = new Error("not a directory")
			err.code = "ENOTDIR"
			throw err
		})
		await expect(readConfigForWrite(fs, "/cfg/x.toml", JSON.parse)).resolves.toEqual({})
	})

	it("returns the parsed config when the file is readable", async () => {
		const fs = io(async () => JSON.stringify({ openai: { base_url: "http://x" } }))
		await expect(readConfigForWrite(fs, "/cfg/x.json", JSON.parse)).resolves.toEqual({
			openai: { base_url: "http://x" },
		})
	})

	it("refuses to proceed when the content will not parse", async () => {
		const fs = io(async () => "{ this is not json")
		await expect(readConfigForWrite(fs, "/cfg/x.json", JSON.parse)).rejects.toBeInstanceOf(
			ConfigUnreadableError,
		)
	})

	it("refuses to proceed on a permissions failure, rather than starting empty", async () => {
		// EACCES is not "missing": treating it as empty is exactly the data-loss path.
		const fs = io(async () => {
			const err: any = new Error("permission denied")
			err.code = "EACCES"
			throw err
		})
		await expect(readConfigForWrite(fs, "/cfg/x.json", JSON.parse)).rejects.toBeInstanceOf(
			ConfigUnreadableError,
		)
	})

	it("names the file and the cause in the error, so the operator can act", async () => {
		const fs = io(async () => "{ broken")
		await expect(readConfigForWrite(fs, "/etc/tool/config.json", JSON.parse)).rejects.toThrow(
			/\/etc\/tool\/config\.json/,
		)
		await expect(readConfigForWrite(fs, "/etc/tool/config.json", JSON.parse)).rejects.toThrow(
			/Refusing to overwrite/,
		)
	})

	it("treats a parser returning null as an empty config", async () => {
		const fs = io(async () => "")
		await expect(readConfigForWrite(fs, "/cfg/x.json", () => null as any)).resolves.toEqual({})
	})

	it("surfaces the original error as the cause", async () => {
		const fs = io(async () => "{ broken")
		try {
			await readConfigForWrite(fs, "/cfg/x.json", JSON.parse)
			throw new Error("should have thrown")
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigUnreadableError)
			expect((error as ConfigUnreadableError).cause).toBeDefined()
		}
	})
})
