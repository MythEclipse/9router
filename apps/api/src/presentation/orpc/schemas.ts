/**
 * Zod schemas for every oRPC boundary.
 *
 * Validation lives here and nowhere else: a router that validates inline cannot
 * be reused by the OpenAPI spec, and a use-case that validates cannot be called
 * from a CLI without duplicating the rules.
 */
import { z } from "zod"

export const CreateApiKeySchema = z.object({
	name: z.string().min(1).max(100),
})

export const RevokeApiKeySchema = z.object({
	id: z.string().min(1),
})

export const EmptySchema = z.object({})

/** Serialised key shape. Never carries `keyHash` outward. */
export const ApiKeyViewSchema = z.object({
	id: z.string(),
	name: z.string(),
	keyPrefix: z.string(),
	createdAt: z.date(),
	lastUsedAt: z.date().nullable(),
	revokedAt: z.date().nullable(),
})

export const CreatedApiKeySchema = z.object({
	key: ApiKeyViewSchema,
	/** Shown exactly once. */
	secret: z.string(),
})

export const HealthSchema = z.object({
	status: z.literal("ok"),
	uptimeSeconds: z.number(),
})

/** Both changelogs are optional: an offline install legitimately has neither. */
export const ChangelogSchema = z.object({
	ok: z.boolean(),
	official: z.string().nullable(),
	custom: z.string().nullable(),
})

/**
 * The login gate. Public by design: the login screen has to ask whether a
 * password is required before anyone can authenticate.
 */
export const LoginGateSchema = z.object({
	requireLogin: z.boolean(),
	tunnelDashboardAccess: z.boolean(),
	tunnelUrl: z.string(),
	tailscaleUrl: z.string(),
	/** True when the settings row could not be read and defaults were used. */
	degraded: z.boolean(),
})
