/**
 * Catalogue sync and single-model probing.
 *
 * `GET /catalog-sync` reads a state object and a file summary from two places;
 * `POST` starts a sync that may already be running. Both used to answer 200 with
 * whatever they found, including a `null` catalog and a `null` result — the
 * dashboard then rendered an empty table with no explanation.
 *
 * A sync that is already running is `503`, not success: the caller asked for a
 * refresh and did not get one.
 */
import { invalid, upstream } from "../../domain/errors.ts"
import type { CatalogueSyncPort, ModelProbePort } from "./ports.ts"

export interface CatalogueSyncDependencies {
	readonly sync: CatalogueSyncPort
}

export function makeCatalogueSync({ sync }: CatalogueSyncDependencies) {
	return {
		async status() {
			const state = sync.state()
			return { ...state, catalog: await sync.fileSummary() }
		},

		/** Refuses with the reason a refresh cannot start, so the caller can retry. */
		async runNow(): Promise<unknown> {
			const result = await sync.run()
			if (result === null) {
				throw upstream(sync.state().lastError || "sync in progress")
			}
			return result
		},
	}
}

export type CatalogueSync = ReturnType<typeof makeCatalogueSync>

export interface ModelProbeDependencies {
	readonly probe: ModelProbePort
}

export function makeModelProbe({ probe }: ModelProbeDependencies) {
	return {
		/**
		 * Ping one model. `kind` defaults to a chat probe: an embedding model run
		 * through the chat path fails with a provider error that reads like a bad
		 * key, which is the wrong thing to show an operator.
		 */
		async ping(body: { model?: unknown; kind?: unknown }): Promise<Record<string, unknown>> {
			if (typeof body.model !== "string" || !body.model.trim()) throw invalid("Model required")
			const kind = typeof body.kind === "string" && body.kind ? body.kind : "llm"
			return probe.ping(body.model.trim(), kind)
		},
	}
}

export type ModelProbe = ReturnType<typeof makeModelProbe>
