/**
 * The three reads the config export needs, from the shared database.
 *
 * Thin on purpose: the shape of an export is a domain decision (`domain/config-export.ts`
 * redacts and sorts it), and the collection of a provider's connections is the repo's. This
 * file exists only so `application/` never imports the database layer.
 */
import { getApiKeys } from "@9router/db/repos/apiKeysRepo"
import { getCombos } from "@9router/db/repos/combosRepo"
import { getProviderConnections } from "@9router/db/repos/connectionsRepo"
import type { ConfigExportSources } from "../../../application/settings/config-export.ts"

export function configExportSources(): ConfigExportSources {
	return {
		providers: async () => await getProviderConnections(),
		combos: async () => await getCombos(),
		keys: async () => await getApiKeys(),
	}
}
