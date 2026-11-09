/**
 * `9router connect <server-url>` — point local CLI tools (Claude Code, Codex, …) at a
 * REMOTE 9router server. Nothing runs locally: we log in with the dashboard
 * password, reuse/create an API key for this machine, then write the tool's
 * settings files (see connectTools.js). Works via `npx 9router connect …` with no global install.
 *
 * The password and API key are never printed (key is masked).
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import enquirer from "enquirer"
import { CLAUDE_MODELS, resolveTools, TOOL_IDS, TOOLS } from "../connectTools.js"

const { Password, MultiSelect } = enquirer

const HELP = `
Usage: 9router connect <server-url> [options]

Configure CLI tools on THIS machine to use a remote 9router server.
No local server is started. Run without installing:

  npx 9router connect http://<server-host>:20128
  npx 9router connect http://<server-host>:20128 --tools claude,codex,opencode

Options:
  --tools <list>         Comma-separated tools to configure (prompted if omitted
                         in a terminal; default: claude). Supported:
                         ${TOOL_IDS.join(", ")}, all
  --password <pw>        Dashboard password (or env NINE_ROUTER_PASSWORD;
                         prompted if omitted — preferred, keeps it out of shell history)
  --save                 After a successful login, save the password for this server
                         to ~/.9router/connect.env (plain text, mode 600) so later
                         runs skip the prompt. Delete that file to forget it.
  --key-name <name>      API key name to reuse/create (default: cli-<hostname>)
  --api-key <key>        Use this API key, skip login + key lookup
  --model <model>        Model for all non-Claude tools (default: each tool's own
                         model on the server, else the server's OpenCode model;
                         omp needs none — it discovers every server model)
  --fable|--opus|--sonnet|--haiku <model>
                         Override a Claude Code tier (default: the server's value)
  --print-env            Also print OpenAI-compatible env vars for other CLIs
  --reset                Remove 9router settings from the selected tools and exit
  -h, --help             Show this help

Models come from the server's own CLI-tools config (set on its dashboard).
Nothing is hardcoded: a Claude tier the server leaves unset is left unset,
and a non-Claude tool with no model anywhere is skipped. Flags override:

  npx 9router connect http://<server-host>:20128 --tools claude --sonnet cc/claude-sonnet-5-5
  npx 9router connect http://<server-host>:20128 --tools codex,opencode --model ocg/deepseek-flash
`

function parseArgs(argv) {
	const opts = {
		password: process.env.NINE_ROUTER_PASSWORD || null,
		keyName: `cli-${os.hostname()}`.slice(0, 64),
		apiKey: null,
		models: {},
	}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		const next = () => {
			const v = argv[++i]
			if (v === undefined) throw new Error(`Missing value for ${a}`)
			return v
		}
		if (a === "--password") opts.password = next()
		else if (a === "--key-name") opts.keyName = next()
		else if (a === "--api-key") opts.apiKey = next()
		else if (a === "--tools") opts.tools = next().split(",")
		else if (a === "--model") opts.model = next()
		else if (a === "--save") opts.save = true
		else if (a === "--print-env") opts.printEnv = true
		else if (a === "--reset") opts.reset = true
		else if (a === "-h" || a === "--help") opts.help = true
		else if (a.startsWith("--") && CLAUDE_MODELS.some((m) => `--${m.flag}` === a))
			opts.models[a.slice(2)] = next()
		else if (!a.startsWith("-") && !opts.url) opts.url = a
		else throw new Error(`Unknown option: ${a}`)
	}
	return opts
}

function normalizeServerUrl(input) {
	let raw = String(input || "").trim()
	if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`
	const u = new URL(raw)
	// Accept pasted dashboard/API URLs: keep only origin.
	return u.origin
}

function maskKey(key) {
	if (!key || key.length < 12) return "****"
	return `${key.slice(0, 6)}…${key.slice(-4)}`
}

// Saved login (`--save`): dotenv file in the CLI data dir, bound to one server so a
// password is never sent to a different host.
function savedEnvPath() {
	if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, "connect.env")
	const base =
		process.platform === "win32"
			? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router")
			: path.join(os.homedir(), ".9router")
	return path.join(base, "connect.env")
}

function loadSavedPassword(server) {
	let text
	try {
		text = fs.readFileSync(savedEnvPath(), "utf8")
	} catch {
		return null
	}
	const env = {}
	for (const line of text.split(/\r?\n/)) {
		const m = /^([A-Z_]+)=(.*)$/.exec(line)
		if (!m) continue
		// Values are written JSON-quoted; accept a hand-edited bare value too
		// rather than crashing the whole command on JSON.parse.
		try {
			env[m[1]] = JSON.parse(m[2])
		} catch {
			env[m[1]] = m[2]
		}
	}
	return env.NINE_ROUTER_SERVER === server && env.NINE_ROUTER_PASSWORD
		? env.NINE_ROUTER_PASSWORD
		: null
}

function savePassword(server, password) {
	const file = savedEnvPath()
	fs.mkdirSync(path.dirname(file), { recursive: true })
	const body = `NINE_ROUTER_SERVER=${JSON.stringify(server)}\nNINE_ROUTER_PASSWORD=${JSON.stringify(password)}\n`
	fs.writeFileSync(file, body, { mode: 0o600 })
	fs.chmodSync(file, 0o600) // mode only applies on create; tighten a pre-existing file too
	return file
}

// Enquirer rejects with an empty value on Ctrl+C / Esc.
class Cancelled extends Error {}
const prompt = (p) =>
	p.run().catch((err) => {
		throw err || new Cancelled("Cancelled")
	})

async function promptPassword() {
	if (!process.stdin.isTTY)
		throw new Error("Password required: pass --password or set NINE_ROUTER_PASSWORD")
	return prompt(new Password({ message: "9router dashboard password" }))
}

async function request(url, { method = "GET", body, cookie, apiKey } = {}) {
	const headers = { Accept: "application/json" }
	if (body) headers["Content-Type"] = "application/json"
	if (cookie) headers.Cookie = cookie
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`
	let res
	try {
		res = await fetch(url, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
			redirect: "manual",
		})
	} catch (err) {
		throw new Error(`Cannot reach ${new URL(url).origin}: ${err.cause?.code || err.message}`)
	}
	let data = null
	try {
		data = await res.json()
	} catch {
		/* non-JSON */
	}
	// Server-controlled strings get printed later — strip control chars (terminal escape injection).
	if (typeof data?.error === "string") data.error = data.error.replace(/[\x00-\x1f\x7f]/g, "")
	return { status: res.status, headers: res.headers, data }
}

function extractAuthCookie(headers) {
	const list =
		typeof headers.getSetCookie === "function"
			? headers.getSetCookie()
			: [headers.get("set-cookie") || ""]
	for (const c of list) {
		const m = /(?:^|,\s*)auth_token=([^;]+)/.exec(c)
		if (m) return `auth_token=${m[1]}`
	}
	return null
}

async function login(server, password) {
	const res = await request(`${server}/api/auth/login`, { method: "POST", body: { password } })
	if (res.status === 200 && res.data?.success) {
		const cookie = extractAuthCookie(res.headers)
		if (!cookie) throw new Error("Login succeeded but server returned no session cookie")
		return cookie
	}
	throw new Error(`Login failed (${res.status}): ${res.data?.error || "unknown error"}`)
}

async function getOrCreateApiKey(server, cookie, keyName) {
	const list = await request(`${server}/api/keys`, { cookie })
	if (list.status === 401)
		throw new Error("Unauthorized listing API keys — wrong password or session rejected")
	if (list.status !== 200)
		throw new Error(`Failed to list API keys (${list.status}): ${list.data?.error || ""}`)
	const keys = (list.data?.keys || []).filter((k) => k.isActive !== false)
	const existing = keys.find((k) => k.name === keyName)
	if (existing) return { key: existing.key, created: false }

	const created = await request(`${server}/api/keys`, {
		method: "POST",
		cookie,
		body: { name: keyName },
	})
	if (created.status !== 201 || !created.data?.key) {
		throw new Error(`Failed to create API key (${created.status}): ${created.data?.error || ""}`)
	}
	return { key: created.data.key, created: true }
}

export {
	Cancelled,
	extractAuthCookie,
	getOrCreateApiKey,
	HELP,
	loadSavedPassword,
	login,
	maskKey,
	normalizeServerUrl,
	parseArgs,
	prompt,
	promptPassword,
	request,
	savedEnvPath,
	savePassword,
}
