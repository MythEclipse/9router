/**
 * Kiro IDE client identity.
 *
 * AWS CodeWhisperer gates every Kiro surface on the client version the caller
 * claims in its `User-Agent`. A build below the current Kiro IDE floor is
 * answered with
 *
 *   {"message":"This version of Kiro is no longer supported. Please update to
 *    the latest version of Kiro to continue."}
 *
 * 9router used to identify as `kiro-ide/1.0.0` / `KiroIDE-0.10.32`, so inference,
 * model listing, usage and API-key validation all failed that gate. This module
 * is the single source of truth for the identity the Kiro IDE itself sends: the
 * same SDK/OS markers plus a per-account machine id upstream uses to correlate a
 * session.
 *
 * Nothing else in the tree may hardcode a Kiro client version. Bump
 * `KIRO_IDE_VERSION` (or set the `KIRO_IDE_VERSION` env var, so an operator can
 * recover from a new version floor without rebuilding) when Kiro raises it.
 */

import { createHash } from "node:crypto"

/** Kiro IDE release this build impersonates. Kiro rejects older clients. */
export const KIRO_IDE_VERSION = process.env.KIRO_IDE_VERSION || "1.4.154"

/** aws-sdk-js version the Kiro IDE embeds in its `User-Agent`. */
export const KIRO_SDK_VERSION = "1.0.0"

// The IDE these markers advertise. Kiro validates the *format* of the UA, so
// they must stay syntactically identical to the IDE's own header.
const KIRO_AGENT_OS = "windows"
const KIRO_AGENT_OS_VERSION = "10.0.26200"
const KIRO_NODE_VERSION = "22.21.1"

/**
 * Per-surface SDK markers. `api/` names the CodeWhisperer service the request
 * hits and `m/` lists the metrics the IDE reports for it: the streaming data
 * plane (`GenerateAssistantResponse`) sends `E`, the runtime/control plane
 * (`ListAvailableModels`, `ListAvailableProfiles`, `GetUsageLimits`) sends `N,E`.
 */
const KIRO_SURFACES = {
	streaming: { api: "codewhispererstreaming", metrics: "E" },
	runtime: { api: "codewhispererruntime", metrics: "N,E" },
} as const

/** Which CodeWhisperer service the request targets. */
export type KiroSurface = keyof typeof KIRO_SURFACES

/** The identity header pair every Kiro surface expects. */
export interface KiroIdentityHeaders {
	"User-Agent": string
	"X-Amz-User-Agent": string
}

/**
 * Minimal credential shape the machine id is derived from. Structural, so both
 * `Credentials` and the ad-hoc `{ accessToken }` / `{ apiKey }` objects built by
 * the OAuth services can be passed straight in.
 */
export interface KiroIdentitySeedSource {
	apiKey?: string | null
	accessToken?: string | null
	refreshToken?: string | null
	providerSpecificData?: { [key: string]: unknown } | null
}

/**
 * Stable per-account machine id: the Kiro IDE suffix that identifies one
 * installation. Derived from the account's most stable identifier and hashed,
 * so no credential ever reaches a header.
 *
 * @param credentials Connection record (or a partial `{ accessToken }`).
 * @returns Lowercase hex sha256, the same shape the IDE sends.
 */
export function kiroMachineId(credentials?: KiroIdentitySeedSource | null): string {
	const psd = credentials?.providerSpecificData
	const seed =
		psd?.clientId ||
		credentials?.refreshToken ||
		psd?.profileArn ||
		credentials?.apiKey ||
		credentials?.accessToken ||
		"kiro-anonymous"
	return createHash("sha256").update(String(seed)).digest("hex")
}

/**
 * Build the `User-Agent` / `X-Amz-User-Agent` pair the Kiro IDE sends.
 *
 * @param credentials Connection record, or a partial carrying the token/key the
 *   request authenticates with. Only used to derive the machine id.
 * @param surface `streaming` for `GenerateAssistantResponse`, `runtime` for the
 *   model/profile/usage control plane.
 * @returns Both header names in canonical casing. Spread into a header object —
 *   never set a lowercase twin alongside it, or fetch would send the value twice.
 */
export function buildKiroIdentityHeaders(
	credentials?: KiroIdentitySeedSource | null,
	surface: KiroSurface = "runtime",
): KiroIdentityHeaders {
	const identity = `KiroIDE-${KIRO_IDE_VERSION}-${kiroMachineId(credentials)}`
	const { api, metrics } = KIRO_SURFACES[surface] || KIRO_SURFACES.runtime
	return {
		"User-Agent":
			`aws-sdk-js/${KIRO_SDK_VERSION} ua/2.1 ` +
			`os/${KIRO_AGENT_OS}#${KIRO_AGENT_OS_VERSION} ` +
			`lang/js md/nodejs#${KIRO_NODE_VERSION} ` +
			`api/${api}#${KIRO_SDK_VERSION} m/${metrics} ${identity}`,
		"X-Amz-User-Agent": `aws-sdk-js/${KIRO_SDK_VERSION} ${identity}`,
	}
}
