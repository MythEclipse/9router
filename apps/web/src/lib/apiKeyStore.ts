/**
 * The legacy key store, handed to `apps/api` as a port.
 *
 * `apps/api` cannot reach `@/lib/localDb` — that alias belongs to this app — so
 * the dashboard key use-cases take these five functions from whoever builds the
 * graph. They are the same calls the route used to make inline.
 */

import type { ApiKeyStore } from "9router-api/infrastructure/db/repositories/api-key-dashboard-repository"
import { getConsistentMachineId } from "@/shared/utils/machineId"
import { createApiKey, deleteApiKey, getApiKeyById, getApiKeys, updateApiKey } from "./localDb"

export function createApiKeyStore(): ApiKeyStore {
	return {
		async list() {
			return (await getApiKeys()) as unknown as Record<string, unknown>[]
		},
		async findById(id) {
			return (await getApiKeyById(id)) as unknown as Record<string, unknown> | null
		},
		async create(name, machineId, scope) {
			return createApiKey(name, machineId, scope)
		},
		async update(id, patch) {
			return updateApiKey(id, patch)
		},
		async remove(id) {
			return deleteApiKey(id)
		},
		async consistentMachineId() {
			return getConsistentMachineId()
		},
	}
}
