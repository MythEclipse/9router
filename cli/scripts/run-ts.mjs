#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const target = process.argv[2]
const commandArgs = process.argv.slice(3)
const compileOnly = commandArgs[0] === "--compile-only"

if (!target) {
	throw new Error("Usage: node scripts/run-ts.mjs <TypeScript entrypoint>")
}

function collectRuntimeEntries(directory) {
	const entries = []
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name)
		if (entry.isDirectory()) entries.push(...collectRuntimeEntries(entryPath))
		else if (entry.isFile() && entry.name.endsWith(".ts")) entries.push(entryPath)
	}
	return entries
}

const targetPath = path.resolve(cliDir, target)
const runtimeEntries =
	target === "cli.ts"
		? [
				targetPath,
				...collectRuntimeEntries(path.join(cliDir, "hooks")),
				...collectRuntimeEntries(path.join(cliDir, "src", "cli")),
			]
		: [targetPath]

await build({
	entryPoints: runtimeEntries,
	outbase: cliDir,
	outdir: cliDir,
	bundle: false,
	format: "esm",
	platform: "node",
	target: "node18",
})

const outputPath = path.join(cliDir, target.replace(/\.ts$/, ".js"))
if (compileOnly) process.exit(0)

const result = spawnSync(process.execPath, [outputPath, ...commandArgs], {
	cwd: cliDir,
	stdio: "inherit",
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
