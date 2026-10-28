/**
 * Environment contract, validated once at startup.
 *
 * A missing or malformed variable must crash the process immediately with a
 * readable message — not surface later as an undefined deep inside a request.
 * Nothing else in the codebase reads `process.env` directly.
 */
import { z } from "zod"

const EnvSchema = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
	PORT: z.coerce.number().int().positive().max(65535).default(20127),
	HOST: z.string().default("127.0.0.1"),

	/** SQLite file. Mirrors the gateway's DATA_DIR-else-~/.9router rule. */
	DATA_DIR: z.string().optional(),

	/** better-auth signing secret. Required outside development. */
	BETTER_AUTH_SECRET: z.string().min(32).optional(),

	/** Base URL better-auth advertises in cookies and callbacks. */
	BETTER_AUTH_URL: z.string().url().default("http://localhost:20127"),

	/** Same-origin web app allowed to call the API from a browser. */
	WEB_ORIGIN: z.string().url().default("http://localhost:20128"),
})

export type Env = z.infer<typeof EnvSchema>

/**
 * Parse process.env, or exit with every problem listed at once.
 *
 * Listing all failures together matters: fixing env one restart at a time is
 * how a deploy loop turns a typo into an outage.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
	const parsed = EnvSchema.safeParse(source)
	if (parsed.success) return withDerivedDefaults(parsed.data)

	const problems = parsed.error.issues
		.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
		.join("\n")
	console.error(`Invalid environment:\n${problems}`)
	process.exit(1)
}

function withDerivedDefaults(env: Env): Env {
	if (env.NODE_ENV === "production" && !env.BETTER_AUTH_SECRET) {
		console.error("Invalid environment:\n  BETTER_AUTH_SECRET: required in production (min 32 chars)")
		process.exit(1)
	}
	return env
}
