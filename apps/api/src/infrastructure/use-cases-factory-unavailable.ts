/** Use-cases factory: unavailable defaults. */
import { randomUUID } from "node:crypto"
import { CUSTOM_PLUGIN_KEYS } from "@9router/db/shared/pluginKeys"
import { makeAdmissionGate } from "../application/batches/admission.ts"
import type { ComboPresetPort, OverrideStore } from "../application/dependencies.ts"
import type { PluginCache } from "../application/plugins/manage-plugins.ts"
import type { ClientListingRegistry } from "../application/providers/list-client-connections.ts"
import type { ProviderCatalogue, StoredConnection } from "../application/providers/ports.ts"
import type { SyncedCatalogue } from "../application/providers/suggest-models.ts"
import type { ValidateCredentialDependencies as ValidateDependencies } from "../application/providers/validate-credential.ts"
import type { WebLoginDependencies } from "../application/providers/web-login.ts"
import type { DeployDeps } from "../application/proxy-pools/deploy-relay.ts"
import type { ImportJobDeps } from "../application/proxy-pools/import-proxy-pools.ts"
import type {
	TailscaleCheckDeps,
	TailscaleInstallDeps,
	TunnelProbeDeps,
	TunnelToggleDeps,
} from "../application/tunnel/manage-tunnel.ts"
import { buildUseCases, type UseCases } from "../application/use-cases.ts"
import { positiveInt } from "../domain/backpressure.ts"
import type { ProviderClassifiers } from "../domain/batch-selection.ts"
import type { CacheEntry, FreeModel, KiloModel } from "../domain/free-model-cache.ts"
import { normalizeKiroExternalIdpAuth } from "../domain/kiro-external-idp.ts"
import type { CatalogueFilters } from "../domain/model-catalogue.ts"
import type { ProbeTarget } from "../domain/model-probe.ts"
import { batchFiles, batchStore } from "./batches/batch-store.ts"
import { createChangelogSourceFromDisk } from "./changelog-source.ts"
import { createComboRotationPort } from "./combo-rotation-port.ts"
import { createDb, resolveDataDir } from "./db/client.ts"
import { runMigrations } from "./db/migrate.ts"
import { createActivityRepository } from "./db/repositories/activity-repository.ts"
import {
	API_KEY_ENDPOINT_KINDS,
	type ApiKeyStore,
	makeApiKeyAuditPort,
	makeApiKeyManagementPort,
	makeBulkEditPort,
	makeSingleKeyAuditPort,
	makeSingleKeyPort,
	matchesAllowedModels,
} from "./db/repositories/api-key-dashboard-repository.ts"
import { createApiKeyRepository } from "./db/repositories/api-key-repository.ts"
import { budgetPoolStore } from "./db/repositories/budget-pool-repository.ts"
import {
	createComboRepository,
	createStudioTargetRepository,
} from "./db/repositories/combo-repository.ts"
import { createComboStrategyRepository } from "./db/repositories/combo-strategy-repository.ts"
import { configExportSources } from "./db/repositories/config-export-repository.ts"
import { createErrorLogRepository } from "./db/repositories/error-log-repository.ts"
import { createIdempotencyStore } from "./db/repositories/idempotency-repository.ts"
import { aggregatesOf as keyUsageAggregates } from "./db/repositories/key-usage-repository.ts"
import {
	createAllowedModelReconciler,
	createComboReaderPort,
	createCustomModelPort,
	createDisabledModelPort,
	createModelAliasPort,
	createNodePrefixPort,
	createProviderConnectionPort,
	createProviderNodePort,
	createStudioModelPort,
	type RegistryHost,
} from "./db/repositories/model-registry-repository.ts"
import {
	createLatencySamplePort,
	createSpendAnomalyPorts,
} from "./db/repositories/observability-repository.ts"
import { createPricingRepository } from "./db/repositories/pricing-repository.ts"
import {
	type ConnectionHost,
	createConnectionNodeStore,
	createConnectionStore,
	createProxyPoolStore,
} from "./db/repositories/provider-connection-repository.ts"
import {
	errorRows as usageErrorRows,
	leaderboardRows as usageLeaderboardRows,
} from "./db/repositories/usage-panel-repository.ts"
import { createUsageReportPort } from "./db/repositories/usage-report-repository.ts"
import { fileStore } from "./files/file-store.ts"
import {
	type CatalogueHost,
	createCatalogueSyncPort,
	createModelCataloguePort,
	createModelProbePort,
} from "./model-catalogue-port.ts"
import { alertPorts } from "./notifications/alert-ports.ts"
import { createPxpipePort, createPxpipeSettings } from "./pxpipe-port.ts"
import { replayPorts } from "./requests/replay-ports.ts"
import { required as takeRequired } from "./requiredPort.ts"
import {
	createDashboardJobEnvironment,
	createDashboardJobRegistry,
	createSemanticCachePort,
	createShutdownEnvironment,
	createShutdownPorts,
	DASHBOARD_JOB_KINDS,
} from "./runtime-ports.ts"
import { createSettingsPort, createSettingsRowPort } from "./settings-port.ts"
import { createUnavailablePresetPort } from "./unavailable-preset-port.ts"

/**
 * The plugin runtime caches its configuration in-process; a host that owns that
 * cache passes a clearer. Without one the write still lands, and the next request
 * that reads the settings row sees it — only a long-lived in-memory copy would
 * stay stale.
 */
export function noPluginCache(): PluginCache {
	return { clear() {} }
}

/**
 * Stands in when the host has no `localDb`. Every call fails loudly: silently
 * returning an empty list would make the dashboard look like a fresh install.
 */
export function unavailableApiKeyStore(): ApiKeyStore {
	const message = "API-key store is not available in this process"
	return {
		async list() {
			throw new Error(message)
		},
		async create() {
			throw new Error(message)
		},
		async findById() {
			throw new Error(message)
		},
		async update() {
			throw new Error(message)
		},
		async remove() {
			throw new Error(message)
		},
		async consistentMachineId() {
			throw new Error(message)
		},
	}
}

/**
 * Stands in when the host supplies no connection tables.
 *
 * Every call throws. Returning empty lists would make the dashboard render as a
 * fresh install with no providers — a wrong state that looks like a right one.
 */
export function unavailableConnectionHost(): ConnectionHost {
	const message = "The provider-connection store is not available in this process"
	const fail = async (): Promise<never> => {
		throw new Error(message)
	}
	return {
		connections: { list: fail, find: fail, create: fail, update: fail, remove: fail },
		nodes: { find: fail, list: fail },
		pools: {
			exists: fail,
			list: fail,
			findById: fail,
			create: fail,
			update: fail,
			remove: fail,
			removeMany: fail,
			boundConnections: fail,
			supportedScheme: () => false,
			probe: fail,
		},
	}
}

/** Stands in when the host supplies no provider catalogue. */
export function unavailableProviderCatalogue(): ProviderCatalogue {
	return {
		label: (provider) => provider,
		isOpenAICompatible: () => false,
		isAnthropicCompatible: () => false,
		isCustomEmbedding: () => false,
		isWebCookie: () => false,
		apiKeySubstituteField: () => null,
		isCreatable: () => false,
		usesAwsCredentialForm: () => false,
		modelListAdapter: () => ({ kind: "unsupported" }),
	}
}

/** The identity normaliser, for a host that sends one spelling of each id. */
export function identityProviderId(provider: unknown): string {
	return typeof provider === "string" ? provider.trim() : ""
}

/** Stands in when the host has no settings row for overrides. */
export function unavailableOverrideStore(): OverrideStore {
	const fail = async (): Promise<never> => {
		throw new Error("The provider-override store is not available in this process")
	}
	return {
		read: fail,
		write: fail,
		resolveAlias: (id) => id,
		builtinHeaders: () => ({}),
	}
}

/** A host that supplies no Kilo fetcher gets an explicit failure, not an empty list. */
export async function failingKiloFetch(): Promise<never> {
	throw new Error("No Kilo catalogue fetcher was supplied")
}

/**
 * No classifiers: every connection groups as `apikey`.
 *
 * A host that cannot answer the free/oauth/apikey question must not silently make
 * `oauth` or `free` select nothing — an empty batch would read as "nothing to
 * test" when the truth is "this host cannot tell". Falling back to `apikey` puts
 * every connection in the group the route used as its own default.
 */
export function ungroupableProviders(): ProviderClassifiers {
	return {
		isFree: () => false,
		isOAuth: () => false,
		isApiKey: () => false,
		isCompatible: () => false,
	}
}

/**
 * No registry: nothing is usage-eligible, so the client listing is empty.
 *
 * Empty rather than everything: this endpoint discloses connection details, and a
 * host that cannot say which providers support usage has no business answering
 * with a full list.
 */
export function unlistableProviders(): ClientListingRegistry {
	return {
		isCompatible: () => false,
		supportsUsage: () => false,
		supportsApiKeyUsage: () => false,
		usageOrder: [],
	}
}

/**
 * No transport: a probe that refuses loudly.
 *
 * Throwing beats answering `{ valid: false }`: a host with no network access must
 * not tell the operator their key is bad when it never asked anyone.
 */
export function unreachableProbe(): ValidateDependencies["send"] {
	return async () => {
		throw new Error("validation probes are not configured on this host")
	}
}

/** A probe this host cannot run, reported as unsupported rather than invalid. */
export async function unsupportedProbe(): Promise<{ valid: boolean; error: string | null }> {
	return { valid: false, error: "Provider validation not supported" }
}

/**
 * No web-login driver: every session looks absent.
 *
 * `statusOf` returning null makes a poll answer 404, which is exactly right — there
 * is no login in progress because this host cannot start one. The store and the
 * label are supplied by `buildUseCases`, so they are not part of this slice.
 */
export function unavailableWebLogin(): Omit<WebLoginDependencies, "connections" | "providerLabel"> {
	return {
		listProviders: () => [],
		listProfiles: () => [],
		configOf: () => null,
		statusOf: () => null,
		start: async () => {
			throw new Error("web login is not configured on this host")
		},
		cancel: () => false,
		fetchIdentity: async () => ({ status: "invalid", error: "web login is not configured" }),
	}
}
