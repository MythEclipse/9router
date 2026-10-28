import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface PerchCliSession {
	accessToken: string
	refreshToken?: string
	expiresAt?: number
	appUrl?: string
	userId?: string
	email?: string
}

export function normalizePerchExpiry(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined
	let timestamp = typeof value === "number" ? value : Number(value)
	if (!Number.isFinite(timestamp) && typeof value === "string") timestamp = Date.parse(value) / 1000
	if (!Number.isFinite(timestamp)) throw new Error("Perch AI session contains an invalid expiry")
	return Math.floor(timestamp > 10_000_000_000 ? timestamp / 1000 : timestamp)
}

export function readPerchCliSession(): PerchCliSession | null {
	const authPath = path.join(os.homedir(), ".perch", "cli-auth-session.json")
	if (!fs.existsSync(authPath)) return null
	let value: unknown
	try {
		value = JSON.parse(fs.readFileSync(authPath, "utf8"))
	} catch (error) {
		throw new Error(
			`Could not parse Perch CLI session: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (
		!value ||
		typeof value !== "object" ||
		typeof (value as PerchCliSession).accessToken !== "string"
	) {
		throw new Error("Perch CLI session does not contain an accessToken")
	}
	const session = value as PerchCliSession & { expires_at?: unknown }
	if (!session.accessToken.trim()) throw new Error("Perch CLI session contains an empty accessToken")
	return {
		...session,
		expiresAt: normalizePerchExpiry(session.expiresAt ?? session.expires_at),
	}
}
