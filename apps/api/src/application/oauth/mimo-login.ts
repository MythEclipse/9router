import {
	directEgress,
	firstHopRefusal,
	type MimoEgress,
	type MimoRegion,
	needsEgressProbe,
	probedEgress,
	readMimoRegion,
	secondHopRefusal,
} from "../../domain/mimo-login.ts"

/**
 * Walking the first two hops of the MiMo Desktop login, server-side.
 *
 * The browser cannot reach the cluster's login surface itself and then carry cookies back to
 * this origin, so the server walks far enough to learn which page to show and stops there. The
 * remaining traffic goes through the login proxy, which is why this answers a *path* rather
 * than a page.
 */

/** What the host must provide: the two hops and the optional proxy probe. */
export interface MimoLoginStartDeps {
	/** First local HTTP proxy that can reach the account host, or null. */
	readonly probeLocalProxy: () => Promise<string | null>
	/** The cluster's `me` URL, whose base the host already resolved from the region. */
	readonly meUrl: string
	/** One request that does not follow redirects, carrying the login session's cookies. */
	readonly hop: (
		url: string,
		userAgent: string,
	) => Promise<{ status: number; location: string | null }>
}

export interface MimoLoginStarted {
	readonly ok: boolean
	readonly status: number
	readonly region: MimoRegion
	readonly egress: MimoEgress
	readonly body: Record<string, unknown>
}

/**
 * `POST /api/oauth/xiaomi-mimo/login/start` — { region }.
 *
 * The egress decision has to be made *before* the first hop, because the hop is what uses it.
 * CN never probes: the default cluster answers directly, and a probe there would only delay
 * every login on the common path.
 */
export async function startMimoLogin(
	body: unknown,
	deps: MimoLoginStartDeps,
): Promise<MimoLoginStarted> {
	const region = readMimoRegion(body)

	const egress = needsEgressProbe(region)
		? probedEgress(await deps.probeLocalProxy())
		: directEgress()

	const me = await deps.hop(deps.meUrl, "native")
	const meRefusal = firstHopRefusal(me.status, me.location)
	if (meRefusal) {
		return refused(region, egress, 502, meRefusal)
	}

	const serviceLogin = await deps.hop(me.location as string, "sso")
	const pageRefusal = secondHopRefusal(serviceLogin.status, serviceLogin.location)
	if (pageRefusal) {
		return refused(region, egress, 502, pageRefusal)
	}

	return {
		ok: true,
		status: 200,
		region,
		egress,
		body: { success: true, pageUrl: serviceLogin.location, region },
	}
}

function refused(
	region: MimoRegion,
	egress: MimoEgress,
	status: number,
	error: string,
): MimoLoginStarted {
	return { ok: false, status, region, egress, body: { error } }
}
