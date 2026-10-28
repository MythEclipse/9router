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

/**
 * A combo name is restricted at the boundary to the same character set the
 * domain enforces, so the 400 arrives with a field path instead of a bare
 * message. The domain check stays — it is the rule; this is the presentation.
 */
const ComboNameSchema = z
	.string()
	.min(1, "Name is required")
	.max(120)
	.regex(/^[a-zA-Z0-9_.-]+$/, "Name can only contain letters, numbers, -, _ and .")

export const ComboViewSchema = z.object({
	id: z.string(),
	name: z.string(),
	models: z.array(z.string()),
	kind: z.string().nullable().optional(),
	contextWindow: z.number().optional(),
})

export const ListCombosOutputSchema = z.object({ combos: z.array(ComboViewSchema) })

export const ComboIdSchema = z.object({ id: z.string().min(1) })

export const CreateComboSchema = z.object({
	name: ComboNameSchema,
	models: z.array(z.string()).default([]),
	kind: z.string().nullable().optional(),
	/** 0 or absent means auto: the window follows the largest member. */
	contextWindow: z.coerce.number().optional(),
})

export const UpdateComboSchema = z.object({
	id: z.string().min(1),
	name: ComboNameSchema.optional(),
	models: z.array(z.string()).optional(),
	kind: z.string().nullable().optional(),
	contextWindow: z.coerce.number().optional(),
})

/** Asks whether a studio would route back into a combo; used by the editor. */
export const ComboCycleQuerySchema = z.object({
	studioName: z.string().min(1),
	comboName: z.string().min(1),
})

/** Which client's preset list to build. The host validates the actual set. */
export const ComboPresetSourceSchema = z.object({ source: z.string().min(1) })
