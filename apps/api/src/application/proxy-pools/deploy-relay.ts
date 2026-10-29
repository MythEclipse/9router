import { invalid, upstream } from "../../domain/errors.ts"
import {
	DEPLOY_POLL_INTERVAL_MS,
	deployedPoolOf,
	deploymentReady,
	deployRequestOf,
	type RelayProvider,
	relayEndpointOf,
	shouldKeepPolling,
	siteNameOf,
} from "../../domain/relay-deploy.ts"
import type { ProxyPoolRow } from "../providers/ports.ts"

/**
 * Deploying a relay and registering it as a proxy pool.
 *
 * One use-case for four providers, because the shape is the same and only the calls
 * differ: start a deployment, wait for it to serve, then register the URL as a pool. The
 * provider-specific work — which endpoint, which payload, which field in the answer — lives
 * behind `RelayProviderDeps`, so adding a fifth provider cannot change the order of these
 * steps.
 */

/** What a provider's deployment API told us. */
export interface StartedDeployment {
	readonly id: string
	/** The project id, when the provider distinguishes it from the deployment id. */
	readonly projectId?: string | null
	readonly state?: string | null
	/** The URL, when the provider reports it at start rather than after a poll. */
	readonly url?: string | null
}

/** A provider's answer when the deployment is polled. */
export interface DeploymentState {
	readonly state: string | null
	/** The host or URL the deployment answers on, once ready. */
	readonly url?: string | null
}

/** The HTTP work for one provider. */
export interface RelayProviderDeps {
	/** Start a deployment; throws `upstream()` with the provider's own message. */
	readonly start: (input: {
		token: string
		projectName: string
		/** The provider's own required fields, validated by the domain. */
		fields: Record<string, string>
	}) => Promise<StartedDeployment>
	/** Ask how the deployment is doing. */
	readonly poll: (input: {
		token: string
		deploymentId: string
		projectId?: string | null
	}) => Promise<DeploymentState>
	/** Work the provider needs done once, after the deployment exists (e.g. disable SSO). */
	readonly afterStart?: (input: {
		token: string
		deploymentId: string
		projectId?: string | null
	}) => Promise<void>
	/**
	 * Undo a half-made deployment.
	 *
	 * Deno creates an app and then deploys into it; if the deploy fails, the app stays
	 * behind under a name the operator may want to reuse. Called only on failure.
	 */
	readonly discard?: (input: { token: string; deployment: StartedDeployment }) => Promise<void>
}

export interface DeployDeps {
	readonly provider: (name: RelayProvider) => RelayProviderDeps | null
	readonly createPool: (input: Record<string, unknown>) => Promise<ProxyPoolRow>
	/** Wait between polls. Injected so a test does not sleep for two minutes. */
	readonly sleep: (ms: number) => Promise<void>
	readonly now: () => number
}

export interface DeployResult {
	readonly proxyPool: ProxyPoolRow
	readonly deployUrl: string
}

/**
 * `POST /api/proxy-pools/<provider>-deploy` — { token, projectName }.
 *
 * A failed deployment answers `upstream()`: the provider is the one that refused, and
 * reporting 500 would send the operator looking at 9router for a problem that is not here.
 */
export async function deployRelay(
	input: { readonly provider: RelayProvider; readonly body: Record<string, unknown> },
	deps: DeployDeps,
): Promise<DeployResult> {
	const provider = deps.provider(input.provider)
	if (!provider) throw invalid(`Unknown relay provider: ${input.provider}`)

	const request = deployRequestOf(input.provider, input.body)
	if ("error" in request) throw invalid(request.error)
	const projectName = siteNameOf(input.provider, input.body.projectName, deps.now())

	const deployment = await provider.start({
		token: request.token,
		projectName,
		fields: request.fields,
	})

	let ready: DeploymentState
	try {
		await provider.afterStart?.({
			token: request.token,
			deploymentId: deployment.id,
			projectId: deployment.projectId,
		})
		ready = await waitForReady(request.token, deployment, provider, deps)
	} catch (error) {
		await provider.discard?.({ token: request.token, deployment }).catch(() => undefined)
		throw error
	}

	const deployUrl = relayEndpointOf(input.provider, ready.url ?? deployment.url ?? "")
	const proxyPool = await deps.createPool(
		deployedPoolOf({ provider: input.provider, projectName, deployUrl }),
	)
	return { proxyPool, deployUrl }
}

/**
 * Poll until the deployment serves, or refuse.
 *
 * A deployment that reports a terminal failure is refused with that state, not with
 * "timed out": waiting out the full two minutes to then report the wrong cause is worse
 * than no report at all.
 */
async function waitForReady(
	token: string,
	deployment: StartedDeployment,
	provider: RelayProviderDeps,
	deps: DeployDeps,
): Promise<DeploymentState> {
	const startedAt = deps.now()
	let state: DeploymentState = {
		state: deployment.state ?? "QUEUED",
		url: deployment.url ?? null,
	}
	if (deploymentReady(state.state) && state.url) return state

	while (shouldKeepPolling({ startedAt, now: deps.now(), state: state.state })) {
		await deps.sleep(DEPLOY_POLL_INTERVAL_MS)
		const polled = await provider.poll({
			token,
			deploymentId: deployment.id,
			projectId: deployment.projectId,
		})
		// A provider that reported its URL at start does not repeat it on every poll, and
		// dropping to `null` here would lose the address the pool needs.
		state = { state: polled.state, url: polled.url ?? state.url ?? null }
	}

	if (!deploymentReady(state.state)) {
		throw upstream(`Deployment failed: ${state.state ?? "unknown"}`)
	}
	if (!state.url) throw upstream("Deployment reported ready without a URL")
	return state
}
