/**
 * Probe every model on one connection.
 *
 * The route resolved the provider, the alias and the model list, then fanned out.
 * The fan-out rules are in `domain/model-probe.ts`; this reads the connection,
 * decides whether a live list is worth fetching, and reports.
 */

import { invalid, notFound } from "../../domain/errors.ts"
import {
	needsLiveModels,
	type ProbeResult,
	type ProbeTarget,
	probeAll,
	targetsFromLiveModels,
} from "../../domain/model-probe.ts"
import type { ConnectionStore, ProviderCatalogue } from "./ports.ts"

export interface ProbeModelsDependencies {
	readonly connections: ConnectionStore
	readonly catalogue: ProviderCatalogue
	/** The models the catalogue knows for this provider alias. */
	readonly knownModels: (alias: string) => readonly ProbeTarget[]
	/** The alias the router resolves this provider id through. */
	readonly aliasOf: (provider: string) => string
	/** Fetches the live list from a compatible connection, or null when it fails. */
	readonly liveModels: (connectionId: string) => Promise<readonly Record<string, unknown>[] | null>
	/** Probes one model through the router. */
	readonly probe: (modelRef: string, kind: string) => Promise<Record<string, unknown>>
	/** Whether this provider serves one request at a time. */
	readonly isSerialProbe: (provider: string) => boolean
}

export function makeProbeModels({
	connections,
	catalogue,
	knownModels,
	aliasOf,
	liveModels,
	probe,
	isSerialProbe,
}: ProbeModelsDependencies) {
	return {
		/**
		 * Probe every model the connection can reach.
		 *
		 * A live list is only fetched for a compatible provider the catalogue knows
		 * nothing about: a provider with a configured list does not need a network
		 * call to be probed, and a failed live fetch is not fatal — it just leaves
		 * the catalogue's own list.
		 */
		async run(connectionId: string): Promise<{
			readonly provider: string
			readonly connectionId: string
			readonly results: ProbeResult[]
		}> {
			const connection = await connections.find(connectionId)
			if (!connection) throw notFound("Connection")

			const provider = connection.provider
			const alias = aliasOf(provider)
			let targets = [...knownModels(alias)]

			const isCompatible =
				catalogue.isOpenAICompatible(provider) || catalogue.isAnthropicCompatible(provider)
			if (needsLiveModels({ isCompatible, knownModels: targets.length })) {
				const live = await liveModels(connectionId).catch(() => null)
				if (live) targets = targetsFromLiveModels(live)
			}

			if (targets.length === 0) throw invalid("No models configured for this provider")

			const results = await probeAll(targets, {
				alias,
				probe,
				serial: isSerialProbe(provider),
			})
			return { provider, connectionId, results }
		},
	}
}
