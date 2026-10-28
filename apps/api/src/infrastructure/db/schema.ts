/**
 * Drizzle schema — single-tenant.
 *
 * One installation, one owner, one dashboard login, so there is no tenant
 * column anywhere by design. Adding tenancy later is a migration that adds an
 * `orgId` and backfills; pre-building it now would be unused complexity.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const apiKeys = sqliteTable("api_keys", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	/** Searchable prefix so a presented key can be located without scanning. */
	keyPrefix: text("key_prefix").notNull().unique(),
	keyHash: text("key_hash").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
	revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
})

/** Append-only audit trail for mutations. Written inside use-cases, never routers. */
export const activity = sqliteTable("activity", {
	id: text("id").primaryKey(),
	action: text("action").notNull(),
	subject: text("subject").notNull(),
	/** JSON-encoded payload; kept as text so the log survives schema drift. */
	payload: text("payload"),
	at: integer("at", { mode: "timestamp_ms" }).notNull(),
})

/**
 * better-auth's own tables. Column names are dictated by better-auth's core
 * schema; do not rename them without checking its migration guide.
 */
export const user = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
	image: text("image"),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
})

export const session = sqliteTable("session", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	token: text("token").notNull().unique(),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
})

export const account = sqliteTable("account", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
	refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
	scope: text("scope"),
	password: text("password"),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
})

export const verification = sqliteTable("verification", {
	id: text("id").primaryKey(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
})
