/**
 * The config export use-case: read three collections, hand them to the redacting rule.
 *
 * The reads are ports rather than imports because this lives in `application/` — the database
 * belongs to `infrastructure/`. Absent ports are a wiring fault, not an empty export: a config
 * document that silently contains no providers reads exactly like an install with none, and
 * that is the failure a reviewer would sign off on.
 */
import {
	type ConfigDocument,
	type ConfigSections,
	configDocument,
	configFilename,
	configJson,
} from "../../domain/config-export.ts"
import { AppError } from "../../domain/errors.ts"

export interface ConfigExportSources {
	readonly providers: () => Promise<readonly unknown[]>
	readonly combos: () => Promise<readonly unknown[]>
	readonly keys: () => Promise<readonly unknown[]>
}

export interface ConfigExport {
	readonly export: () => Promise<{
		readonly filename: string
		readonly document: ConfigDocument
		readonly body: string
		readonly contentType: string
	}>
}

export function makeConfigExport(sources: ConfigExportSources): ConfigExport {
	return {
		async export() {
			for (const [name, read] of Object.entries(sources)) {
				if (typeof read !== "function") {
					throw new AppError("INTERNAL", `configExport.${name} was not supplied`)
				}
			}
			const now = new Date()
			const sections: ConfigSections = {
				providers: await sources.providers(),
				combos: await sources.combos(),
				keys: await sources.keys(),
			}
			const document = configDocument(sections, now)
			return {
				filename: configFilename(now),
				document,
				body: configJson(document),
				contentType: "application/json; charset=utf-8",
			}
		},
	}
}
