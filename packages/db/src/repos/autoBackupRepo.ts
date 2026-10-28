// Automatic-backup config + status (channel: telegram | github). Secrets are
// encrypted at rest with a machine-bound key (same scheme as mitm sudo
// password). Lives in its own KV scope so tokens never travel through the
// settings blob; it also round-trips inside DB backups (see exportDb/importDb)
// so a restored instance keeps its schedule.
import crypto from "node:crypto"
import nodeMachineId from "node-machine-id"

const { machineIdSync } = nodeMachineId

import { makeKv } from "../helpers/kvStore.ts"

const kv = makeKv("autoBackup")

/** Config fields that hold a secret and must be encrypted at rest. */
const SECRET_FIELDS = ["tgBotToken", "ghToken"]

function isSecretField(key: string): boolean {
	return SECRET_FIELDS.includes(key)
}

const ENCRYPT_ALGO = "aes-256-gcm"
const ENCRYPT_SALT = "9router-backup-token-salt"

function deriveKey() {
	try {
		return crypto
			.createHash("sha256")
			.update(machineIdSync() + ENCRYPT_SALT)
			.digest()
	} catch {
		return crypto.createHash("sha256").update(ENCRYPT_SALT).digest()
	}
}

export function encryptSecret(plaintext: string): string {
	if (typeof plaintext !== "string" || !plaintext) return plaintext
	const key = deriveKey()
	const iv = crypto.randomBytes(12)
	const cipher = crypto.createCipheriv(ENCRYPT_ALGO, key, iv)
	const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
	const tag = cipher.getAuthTag()
	return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`
}

export function decryptSecret(stored: unknown): string {
	if (typeof stored !== "string" || !stored) return ""
	const [ivHex, tagHex, dataHex] = stored.split(":")
	if (!ivHex || !tagHex || !dataHex) return stored // pre-encryption plaintext value
	try {
		const key = deriveKey()
		const decipher = crypto.createDecipheriv(ENCRYPT_ALGO, key, Buffer.from(ivHex, "hex"))
		decipher.setAuthTag(Buffer.from(tagHex, "hex"))
		return decipher.update(Buffer.from(dataHex, "hex")) + decipher.final("utf8")
	} catch {
		return "" // wrong machine / tampered value
	}
}

/** The persisted `autoBackup/config` kv blob. Secrets held here are ciphertext. */
interface AutoBackupConfig {
	enabled: boolean
	channel: string
	intervalHours: number
	tgBotToken: string
	tgChatId: string
	ghToken: string
	ghRepo: string
}

const DEFAULT_CONFIG: AutoBackupConfig = {
	enabled: false,
	channel: "telegram", // telegram | github
	intervalHours: 24,
	tgBotToken: "",
	tgChatId: "",
	ghToken: "",
	ghRepo: "", // owner/repo
}

export async function getAutoBackupConfig(): Promise<AutoBackupConfig> {
	const stored = { ...DEFAULT_CONFIG, ...(await kv.get<Partial<AutoBackupConfig>>("config", {})) }
	return {
		...stored,
		tgBotToken: decryptSecret(stored.tgBotToken),
		ghToken: decryptSecret(stored.ghToken),
	}
}

// Patches may carry plaintext secrets; they are encrypted before storage.
// An empty-string secret means "keep the stored one" and must be omitted.
export async function setAutoBackupConfig(
	patch: Partial<AutoBackupConfig>,
): Promise<AutoBackupConfig> {
	const current = await kv.get<Partial<AutoBackupConfig>>("config", {})
	const next: Record<string, unknown> = { ...current }
	for (const [key, value] of Object.entries(patch)) {
		if (isSecretField(key)) {
			if (typeof value === "string" && value) next[key] = encryptSecret(value.trim())
			continue
		}
		next[key] = value
	}
	await kv.set("config", next)
	return getAutoBackupConfig()
}

/** Timestamped outcome of the last automatic-backup run. */
export interface AutoBackupStatus {
	lastSentAt?: string
	ok?: boolean
	error?: string
	[key: string]: unknown
}

export async function getAutoBackupStatus(): Promise<AutoBackupStatus | null> {
	return kv.get<AutoBackupStatus>("status", null)
}

export async function setAutoBackupStatus(status: AutoBackupStatus): Promise<void> {
	await kv.set("status", status)
}
