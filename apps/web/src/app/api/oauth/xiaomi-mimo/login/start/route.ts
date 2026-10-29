import { request as httpRequest } from "node:http"
import { NextResponse } from "next/server"
import {
	absorbSetCookies as absorbResponseCookies,
	beginSession,
	encodeSessionCookie,
	loginUpstreamFetch,
	originOf,
	rewriteMimoBases,
	SESSION_COOKIE,
} from "@/lib/mimoLoginSession"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * POST /api/oauth/xiaomi-mimo/login/start
 * Body: { region: "cn" | "sgp" | "ams" | "ru" | "in" }
 *
 * Walks the first two hops of the Desktop login surface server-side
 * (me -> 302 account/pass/serviceLogin -> 302 /fe/service/login) and hands
 * the browser a same-origin pageUrl carrying the 9r_mimo_login session cookie.
 * All subsequent account.xiaomi.com traffic flows through src/proxy.js.
 *
 * Egress resolution: MIMO_LOGIN_PROXY env > (non-CN: probe common LOCAL HTTP
 * proxy ports - v2rayN/clash defaults) > direct. The resolved URL rides the
 * session cookie so every hop/XHR uses the same exit.
 */

const API_UA =
	"miNative PC/Normal Windows_NT/10.0.19045 SDKV/1.0.0 DEVT/PC DEVS/Windows APP/miaccount_desktop APPV/0.1.0"
const SSO_UA = "MiClaw/1.0"
const LOCAL_PROXY_PORTS = [10808, 10809, 7890, 7891, 1080, 1081, 8080, 8888]

/** First local port answering a CONNECT to account.xiaomi.com (or null). */
function probeLocalHttpProxy(timeoutMs = 500) {
	const attempts = LOCAL_PROXY_PORTS.map(
		(port) =>
			new Promise((resolve, reject) => {
				let settled = false
				const done = (v) => {
					if (settled) return
					settled = true
					// Promise.any picks the first FULFILLED value - failures must reject,
					// otherwise an instant ECONNREFUSED from a closed candidate port would
					// "win" with null before the real proxy answers.
					if (v) resolve(v)
					else reject(new Error(`no-proxy-${port}`))
				}
				try {
					const req = httpRequest({
						host: "127.0.0.1",
						port,
						method: "CONNECT",
						path: "account.xiaomi.com:443",
						timeout: timeoutMs,
					})
					req.on("connect", (res, socket) => {
						socket.destroy()
						done(res.statusCode === 200 || res.statusCode === 202 ? `http://127.0.0.1:${port}` : null)
					})
					req.on("timeout", () => {
						req.destroy()
						done(null)
					})
					req.on("error", () => done(null))
					req.on("response", () => done(null))
					req.end()
				} catch {
					done(null)
				}
			}),
	)
	return Promise.any(attempts)
		.then((found) => found as string | null)
		.catch(() => null)
}

export async function POST(request) {
	try {
		let body = null
		try {
			body = await request.json()
		} catch {
			/* empty body - default cn */
		}

		// The session carries the cluster base and the cookies every hop must see.
		const session = beginSession(getUseCases().oauth.readMimoRegion(body))
		const agents = { native: API_UA, sso: SSO_UA }

		const started = await getUseCases().oauth.startMimoLogin(body, {
			meUrl: `${session.upstreamBase}/api/user/xiaomi/me`,
			probeLocalProxy: probeLocalHttpProxy,
			hop: async (url, which) => {
				const response = await loginUpstreamFetch(
					url,
					{
						redirect: "manual",
						headers: {
							"User-Agent": agents[which],
							Accept: "text/html,application/json,*/*",
						},
						signal: AbortSignal.timeout(15000),
					},
					session,
				)
				absorbResponseCookies(session, response, url)
				return { status: response.status, location: response.headers.get("location") }
			},
		})

		// Every hop and XHR from here on must use the exit the probe chose.
		session.proxyUrl = started.egress.proxyUrl

		if (!started.ok) {
			return NextResponse.json(started.body, { status: started.status })
		}

		const pageUrl = new URL(String(started.body.pageUrl), "https://account.xiaomi.com")
		const origin = originOf(request)
		// Session travels ONLY in the httpOnly cookie - never in the URL (history,
		// logs, Referer). /login/status re-arms the cookie on every poll, so a
		// dropped-cookie browser still recovers on the next poll cycle.
		const proxiedPath = rewriteMimoBases(pageUrl.pathname + pageUrl.search, "toProxy", origin)

		const res = NextResponse.json({
			success: true,
			state: session.state,
			pageUrl: proxiedPath,
			region: started.region,
		})
		res.cookies.set(SESSION_COOKIE, encodeSessionCookie(session), {
			path: "/",
			httpOnly: true,
			sameSite: "lax",
			maxAge: 15 * 60,
		})
		return res
	} catch (error) {
		return NextResponse.json({ error: error?.message || "login start failed" }, { status: 500 })
	}
}
