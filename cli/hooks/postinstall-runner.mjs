import { spawnSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const hooksDir = path.dirname(fileURLToPath(import.meta.url))
const cliDir = path.dirname(hooksDir)
const postinstallJs = path.join(hooksDir, "postinstall.js")
const generatedFiles = ["postinstall.js", "sqliteRuntime.js", "trayRuntime.js"].map((file) =>
	path.join(hooksDir, file),
)
const generatedBeforeRun = generatedFiles.map((file) => existsSync(file))

if (!existsSync(postinstallJs)) {
	const { build } = await import("esbuild")
	await build({
		entryPoints: [
			path.join(hooksDir, "postinstall.ts"),
			path.join(hooksDir, "sqliteRuntime.ts"),
			path.join(hooksDir, "trayRuntime.ts"),
		],
		outbase: cliDir,
		outdir: cliDir,
		bundle: false,
		format: "esm",
		platform: "node",
		target: "node18",
	})
}

const result = spawnSync(process.execPath, [postinstallJs], {
	cwd: cliDir,
	stdio: "inherit",
})

for (let index = 0; index < generatedFiles.length; index++) {
	if (!generatedBeforeRun[index]) rmSync(generatedFiles[index], { force: true })
}

if (result.error) throw result.error
process.exitCode = result.status ?? 1
