/**
 * Per-tool config writers for `9router connect`. File layout and keys mirror
 * the dashboard routes in src/app/api/cli-tools/<tool>-settings/route.js so a
 * tool configured here looks identical to one applied from the dashboard.
 *
 * Each tool: { id, name, paths(), apply(ctx) → string[] written, reset() → string[] touched }
 * Optional: route + serverModel(data) to inherit the server's model; needsModel: false
 * for tools that discover models themselves (omp).
 * ctx: { baseUrl (origin, no /v1), apiKey, model, claudeModels: { envKey: model } }
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveModelDisplayName } from "../../utils/modelDisplayName.js"

const home = () => os.homedir()
const v1 = (baseUrl) => (baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`)
const isStr = (v) => typeof v === "string" && v.length > 0

// Drop trailing commas (JSONC) outside string literals, so values like "a,}" survive.
function stripTrailingCommas(text) {
	return text.replace(/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g, (_m, str, tail) => str ?? tail)
}

function readJson(file) {
	try {
		return JSON.parse(stripTrailingCommas(fs.readFileSync(file, "utf8")))
	} catch (err) {
		if (err.code === "ENOENT") return null
		throw new Error(`Cannot parse ${file}: ${err.message}`)
	}
}

// Files hold the API key → owner-only (0600) on POSIX; no-op on Windows.
const SECRET_MODE = 0o600

// Rewrite an existing file on reset (no backup, existing mode kept).
function rewriteFile(file, content) {
	fs.writeFileSync(file, content, { mode: SECRET_MODE })
}

// One-time backup of the user's pre-9router file, then write.
function writeFile(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	const backup = `${file}.bak-9router`
	if (fs.existsSync(file) && !fs.existsSync(backup)) {
		fs.copyFileSync(file, backup)
		fs.chmodSync(backup, SECRET_MODE)
	}
	fs.writeFileSync(file, content, { mode: SECRET_MODE })
	fs.chmodSync(file, SECRET_MODE) // mode above only applies when creating
}

const writeJson = (file, data) => writeFile(file, JSON.stringify(data, null, 2))

// confbox (TOML/YAML) is ESM-only; loaded lazily so other tools don't need it.
async function toml() {
	return import("confbox")
}

export {
	home,
	isStr,
	readJson,
	rewriteFile,
	SECRET_MODE,
	stripTrailingCommas,
	toml,
	v1,
	writeFile,
	writeJson,
}
