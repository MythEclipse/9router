/**
 * Provider header overrides: read and write.
 *
 * The route keyed overrides by whatever id the URL carried, so `/gcli/overrides`
 * and `/gemini-cli/overrides` wrote two different entries for one provider. The
 * canonical id is resolved once, here, and every path uses it.
 */

import { invalid } from "../../domain/errors.ts"
import type { ProviderOverride } from "../../domain/provider-override.ts"
import { readOverride, withOverride } from "../../domain/provider-override.ts"

export interface OverrideDependencies {
	/** Reads the stored override map from the settings row. */
	readonly read: () => Promise<Record<string, ProviderOverride>>
	/** Writes it back. */
	readonly write: (overrides: Record<string, ProviderOverride>) => Promise<void>
	/** Maps a URL id — an alias such as `gcli` — to the canonical provider id. */
	readonly resolveAlias: (id: string) => string
	/** The headers the provider's transport already sends, for the UI to pre-fill. */
	readonly builtinHeaders: (canonical: string) => Record<string, string>
}

export function makeOverrides({ read, write, resolveAlias, builtinHeaders }: OverrideDependencies) {
	return {
		/**
		 * The override for one provider and the headers it sends anyway.
		 *
		 * Both are returned because the panel shows them together: the built-in
		 * headers come from the registry transport, which is the single source of
		 * truth for what this provider sends upstream.
		 */
		async get(id: string): Promise<{
			readonly headers: Record<string, string>
			readonly builtinHeaders: Record<string, string>
		}> {
			const canonical = resolveAlias(id)
			const override = (await read())[canonical]
			return {
				headers: override?.headers ?? {},
				builtinHeaders: builtinHeaders(canonical),
			}
		},

		/**
		 * Replace one provider's override.
		 *
		 * An empty payload clears it. `withOverride` deletes the key rather than
		 * storing `{}`, so the settings row does not grow a list of providers the
		 * operator touched once and abandoned.
		 */
		async set(
			id: string,
			payload: { headers?: unknown },
		): Promise<{ readonly headers: Record<string, string> }> {
			const canonical = resolveAlias(id)
			const result = readOverride(payload)
			if (result.kind === "invalid") throw invalid(result.message)

			await write(withOverride(await read(), canonical, result.override))
			return { headers: result.override?.headers ?? {} }
		},
	}
}
