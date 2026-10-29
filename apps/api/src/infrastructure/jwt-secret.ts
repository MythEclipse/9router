/**
 * The JWT signing secret shared with the dashboard.
 *
 * Two processes verify the same cookie, so they must derive the same key. The rule
 * mirrors `packages/auth` exactly, and that is not duplication for its own sake:
 * if the two ever disagree, every session reads as expired and the symptom (a
 * login that "does not stick") points at the cookie, not at the key.
 *
 * Resolution order:
 *   1. `JWT_SECRET` — set it when the two processes do not share a filesystem.
 *   2. `<DATA_DIR>/jwt-secret` — written by whichever process starts first.
 *
 * The file is created with mode `0600`: it is a bearer credential for every
 * dashboard session, and a world-readable copy is a privilege escalation.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/** Where the secret lives, given the data directory both processes share. */
export function jwtSecretPath(dataDir: string): string {
	return path.join(dataDir, "jwt-secret")
}

/**
 * Load the signing key, generating it on first use.
 *
 * `crypto.randomBytes(32)` is 256 bits, the key size HS256 is defined for. A
 * shorter secret would still verify — and would still be brute-forceable.
 */
export function loadJwtSecret(
	dataDir: string,
	env: Record<string, string | undefined> = process.env,
): string {
	const fromEnv = env.JWT_SECRET
	if (fromEnv) return fromEnv

	const file = jwtSecretPath(dataDir)
	try {
		const stored = fs.readFileSync(file, "utf8").trim()
		if (stored) return stored
	} catch {
		// First start: fall through and create it.
	}

	fs.mkdirSync(dataDir, { recursive: true })
	const generated = crypto.randomBytes(32).toString("hex")
	fs.writeFileSync(file, generated, { mode: 0o600 })
	return generated
}
