import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let testApi
try {
	testApi = await import("vitest")
} catch (error) {
	if (error.code !== "ERR_MODULE_NOT_FOUND") throw error
	testApi = await import("node:test")
}
const { afterEach, describe, it } = testApi

import {
	assertDeepSeekPowFiles,
	assertRequiredApiArtifacts,
	copyDeepSeekPowFiles,
	copyStandaloneBuild,
	mergeServerArtifacts,
} from "../../cli/scripts/build-cli.ts"

const tempDirs = []

function createTempDir() {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cli-build-"))
	tempDirs.push(tempDir)
	return tempDir
}

function writeFixture(root, relativePath, contents = relativePath) {
	const filePath = path.join(root, relativePath)
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	fs.writeFileSync(filePath, contents)
	return filePath
}

function createCompleteServer(buildDistDir) {
	const serverDir = path.join(buildDistDir, "server")
	writeFixture(serverDir, "app/api/v1/chat/completions/route.js", "chat route")
	writeFixture(serverDir, "app/api/v1/messages/route.js", "messages route")
	writeFixture(serverDir, "chunks/openai-provider.js", "openai chunk")
	writeFixture(serverDir, "chunks/anthropic-provider.js", "anthropic chunk")
	return serverDir
}

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		fs.rmSync(tempDir, { recursive: true, force: true })
	}
})

describe("CLI build server artifacts", () => {
	for (const { name, standalonePath } of [
		{
			name: "legacy nested app",
			standalonePath: (appDir, _buildDistDir) => path.join(appDir, ".next", "standalone", "app"),
		},
		{
			name: "Next 16 workspace",
			standalonePath: (appDir, buildDistDir) =>
				path.join(buildDistDir, "standalone", path.basename(appDir)),
		},
	]) {
		it(`merges complete API routes and provider chunks for the ${name} layout`, () => {
			const root = createTempDir()
			const appDir = path.join(root, "9router")
			const buildDistDir = path.join(appDir, ".next-cli-build")
			const cliAppDir = path.join(root, "cli-app")
			const standaloneDir = standalonePath(appDir, buildDistDir)

			writeFixture(standaloneDir, "server.js", "standalone server")
			writeFixture(
				standaloneDir,
				".next-cli-build/server/app/api/v1/chat/completions/route.js",
				"standalone chat route",
			)
			createCompleteServer(buildDistDir)

			copyStandaloneBuild(appDir, buildDistDir, cliAppDir)
			mergeServerArtifacts(buildDistDir, cliAppDir)
			assertRequiredApiArtifacts(cliAppDir)

			const packagedServer = path.join(cliAppDir, ".next-cli-build", "server")
			assert.equal(
				fs.readFileSync(path.join(packagedServer, "app/api/v1/messages/route.js"), "utf8"),
				"messages route",
			)
			assert.equal(
				fs.readFileSync(path.join(packagedServer, "chunks/openai-provider.js"), "utf8"),
				"openai chunk",
			)
			assert.equal(
				fs.readFileSync(path.join(packagedServer, "chunks/anthropic-provider.js"), "utf8"),
				"anthropic chunk",
			)
		})
	}

	it("merges idempotently without removing standalone-generated files", () => {
		const root = createTempDir()
		const buildDistDir = path.join(root, ".next-cli-build")
		const cliAppDir = path.join(root, "cli-app")
		const packagedServer = path.join(cliAppDir, ".next-cli-build", "server")

		createCompleteServer(buildDistDir)
		writeFixture(packagedServer, "standalone-only.js", "keep me")

		mergeServerArtifacts(buildDistDir, cliAppDir)
		mergeServerArtifacts(buildDistDir, cliAppDir)

		assert.equal(fs.readFileSync(path.join(packagedServer, "standalone-only.js"), "utf8"), "keep me")
		assert.equal(
			fs.readFileSync(path.join(packagedServer, "app/api/v1/messages/route.js"), "utf8"),
			"messages route",
		)
	})

	it("reports the missing required API route artifact path", () => {
		const root = createTempDir()
		const buildDistDir = path.join(root, ".next-cli-build")
		const cliAppDir = path.join(root, "cli-app")

		writeFixture(
			path.join(buildDistDir, "server"),
			"app/api/v1/chat/completions/route.js",
			"chat route",
		)
		mergeServerArtifacts(buildDistDir, cliAppDir)

		assert.throws(
			() => assertRequiredApiArtifacts(cliAppDir),
			(error) =>
				error.message.includes(
					path.join(cliAppDir, ".next-cli-build/server/app/api/v1/messages/route.js"),
				),
		)
	})
})

describe("CLI build DeepSeek PoW worker files", () => {
	function createPoWSource(appDir: string) {
		writeFixture(path.join(appDir, "open-sse/lib"), "deepseek-pow-worker.mjs", "worker")
		writeFixture(path.join(appDir, "open-sse/lib"), "deepseek-pow-hash.ts", "hash")
	}

	it("copies worker and hash next to each other (standalone tracing drops the worker's import)", async () => {
		const root = createTempDir()
		const appDir = path.join(root, "9router")
		const cliAppDir = path.join(root, "cli-app")
		createPoWSource(appDir)
		// What standalone tracing ships: the worker, followed from the fs reference,
		// but not the module that worker imports.
		writeFixture(path.join(cliAppDir, "open-sse/lib"), "deepseek-pow-worker.mjs", "worker")

		await copyDeepSeekPowFiles(appDir, cliAppDir)
		assertDeepSeekPowFiles(cliAppDir)

		// Emitted, not copied: esbuild strips types, so the content is the source
		// with the bare expression preserved.
		const emitted = fs.readFileSync(path.join(cliAppDir, "open-sse/lib/deepseek-pow-hash.js"), "utf8")
		assert.equal(emitted.includes("hash"), true)
	})

	it("ships the hash under the .js name the worker imports, not its .ts source name", async () => {
		const root = createTempDir()
		const appDir = path.join(root, "9router")
		const cliAppDir = path.join(root, "cli-app")
		createPoWSource(appDir)

		await copyDeepSeekPowFiles(appDir, cliAppDir)

		// A Worker is plain Node ESM: "./deepseek-pow-hash.js" is the only name that
		// resolves. Copying the .ts under its own name would pass a file-exists check
		// and still leave the worker dead.
		assert.equal(fs.existsSync(path.join(cliAppDir, "open-sse/lib/deepseek-pow-hash.js")), true)
		assert.equal(fs.existsSync(path.join(cliAppDir, "open-sse/lib/deepseek-pow-hash.ts")), false)
	})

	it("emits the hash as JavaScript, stripping the type annotations a Worker cannot parse", async () => {
		const root = createTempDir()
		const appDir = path.join(root, "9router")
		const cliAppDir = path.join(root, "cli-app")
		// Shaped like the real source: a typed export the worker imports.
		writeFixture(path.join(appDir, "open-sse/lib"), "deepseek-pow-worker.mjs", "worker")
		writeFixture(
			path.join(appDir, "open-sse/lib"),
			"deepseek-pow-hash.ts",
			"export function solve(prefix: string, n: number): string { return prefix + String(n) }\n",
		)

		await copyDeepSeekPowFiles(appDir, cliAppDir)

		const emitted = fs.readFileSync(path.join(cliAppDir, "open-sse/lib/deepseek-pow-hash.js"), "utf8")
		assert.equal(emitted.includes(": string"), false)
		assert.equal(emitted.includes(": number"), false)
		// And it is real ESM the worker can import, exporting the same name.
		assert.equal(emitted.includes("export"), true)
		assert.equal(emitted.includes("solve"), true)
	})

	it("fails loudly when a PoW source file is missing", async () => {
		const root = createTempDir()
		const appDir = path.join(root, "9router")
		const cliAppDir = path.join(root, "cli-app")
		writeFixture(path.join(appDir, "open-sse/lib"), "deepseek-pow-worker.mjs", "worker")

		await assert.rejects(() => copyDeepSeekPowFiles(appDir, cliAppDir), /deepseek-pow-hash\.ts/)
	})

	it("reports the missing PoW artifact path", () => {
		const root = createTempDir()
		const cliAppDir = path.join(root, "cli-app")
		writeFixture(path.join(cliAppDir, "open-sse/lib"), "deepseek-pow-worker.mjs", "worker")

		assert.throws(
			() => assertDeepSeekPowFiles(cliAppDir),
			(error: Error) =>
				error.message.includes(path.join(cliAppDir, "open-sse/lib/deepseek-pow-hash.js")),
		)
	})
})
