import "server-only"

import type {
	DeployDeps,
	RelayProviderDeps,
	StartedDeployment,
} from "9router-api/application/proxy-pools/deploy-relay"
import { conflict, upstream } from "9router-api/domain/errors"
import type { RelayProvider } from "9router-api/domain/relay-deploy"
import {
	buildIndexFile,
	buildRelayFunctionZip,
	NETLIFY_API,
	NETLIFY_FUNCTION_NAME,
	netlifyHeaders,
	pollDeployReady,
} from "@/lib/network/netlifyRelay"
import { createProxyPool } from "@/models"

/**
 * The four relay providers' HTTP calls.
 *
 * Each is an implementation of the same three steps — start, poll, and the provider's
 * one-off post-start work — because the use-case that orders them is shared. A provider's
 * own error message is carried out as `upstream()`, so the screen shows what the provider
 * said instead of a generic 500.
 */

const VERCEL_API = "https://api.vercel.com"
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"
const DENO_API = "https://api.deno.com/v2"

/** Read a provider's message out of whatever shape it answers with. */
async function providerError(res: Response, fallback: string): Promise<Error> {
	const body = (await res.json().catch(() => ({}))) as {
		error?: { message?: string } | string
		message?: string
		errors?: { message?: string }[]
	}
	const message =
		(typeof body.error === "string" ? body.error : body.error?.message) ||
		body.errors?.[0]?.message ||
		body.message ||
		fallback
	return upstream(message)
}

const VERCEL_RELAY_CODE = `
export const config = { runtime: "edge" };

export default async function handler(req) {
  const target = req.headers.get("x-relay-target");
  const relayPath = req.headers.get("x-relay-path") || "/";
  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const targetUrl = target.replace(/\\/$/, "") + relayPath;

  const rawHeaders = {};
  for (const [k, v] of req.headers.entries()) {
    const lower = k.toLowerCase();
    if (
      lower === "x-relay-target" ||
      lower === "x-relay-path" ||
      lower === "host" ||
      lower.startsWith("x-vercel-") ||
      lower.startsWith("x-forwarded-") ||
      lower === "x-real-ip"
    ) {
      continue;
    }
    rawHeaders[k] = v;
  }

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: rawHeaders,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    duplex: "half",
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
`

const vercel: RelayProviderDeps = {
	start: async ({ token, projectName }) => {
		const res = await fetch(`${VERCEL_API}/v13/deployments`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				name: projectName,
				files: [
					{ file: "api/relay", data: VERCEL_RELAY_CODE },
					{ file: "package.json", data: JSON.stringify({ name: projectName, version: "1.0.0" }) },
					{
						file: "vercel.json",
						data: JSON.stringify({ rewrites: [{ source: "/(.*)", destination: "/api/relay" }] }),
					},
				],
				projectSettings: { framework: null },
				target: "production",
			}),
		})
		if (!res.ok) throw await providerError(res, "Failed to create Vercel deployment")
		const body = (await res.json()) as {
			id?: string
			uid?: string
			projectId?: string
			readyState?: string
		}
		return {
			id: String(body.id ?? body.uid ?? ""),
			projectId: body.projectId ?? projectName,
			state: body.readyState ?? null,
		}
	},

	/**
	 * Disable Vercel's deployment protection.
	 *
	 * A protected deployment answers every relayed request with an SSO page, which looks
	 * exactly like a broken relay from the pool's test. Failure here is not fatal — the
	 * deployment still exists — so it is logged and the poll continues.
	 */
	afterStart: async ({ token, projectId }) => {
		if (!projectId) return
		try {
			await fetch(`${VERCEL_API}/v9/projects/${projectId}`, {
				method: "PATCH",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ ssoProtection: null }),
			})
		} catch (error) {
			console.warn("[ProxyPool][vercel] failed to disable deployment protection:", error)
		}
	},

	poll: async ({ token, deploymentId }) => {
		const res = await fetch(`${VERCEL_API}/v13/deployments/${deploymentId}`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		if (!res.ok) throw await providerError(res, "Failed to read Vercel deployment")
		const body = (await res.json()) as { readyState?: string; url?: string }
		return { state: body.readyState ?? null, url: body.url ?? null }
	},
}

const CLOUDFLARE_WORKER_CODE = `
export default {
  async fetch(request, env, ctx) {
    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";

    if (!target) {
      return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const targetUrl = target.replace(/\\/$/, "") + relayPath;
    const newRequestInit = {
      method: request.method,
      headers: new Headers(request.headers),
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      newRequestInit.body = request.body;
      newRequestInit.duplex = "half";
    }

    newRequestInit.headers.delete("x-relay-target");
    newRequestInit.headers.delete("x-relay-path");
    newRequestInit.headers.delete("host");

    try {
      const response = await fetch(targetUrl, newRequestInit);
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
`

/**
 * A Cloudflare deploy is already one answer.
 *
 * The upload *is* the deploy, and the URL is derived from the account's `workers.dev`
 * subdomain rather than reported by a poll — so `start` finishes ready and carries the URL
 * in the field the poll would have used.
 */
const cloudflare: RelayProviderDeps = {
	start: async ({ token, projectName, fields }) => {
		const accountId = fields.accountId ?? ""
		const scriptUrl = `${CLOUDFLARE_API}/accounts/${accountId}/workers/scripts/${projectName}`

		const form = new FormData()
		form.append(
			"index",
			new Blob([CLOUDFLARE_WORKER_CODE], { type: "application/javascript+module" }),
			"index",
		)
		form.append(
			"metadata",
			new Blob(
				[
					JSON.stringify({
						main_module: "index",
						compatibility_date: "2024-03-20",
						observability: { enabled: true },
					}),
				],
				{ type: "application/json" },
			),
			"metadata.json",
		)

		const upload = await fetch(scriptUrl, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}` },
			body: form,
		})
		if (!upload.ok) throw await providerError(upload, "Failed to upload Worker to Cloudflare")

		// Best-effort: an account that already has the subdomain answers an error, and the
		// worker is deployed either way.
		await fetch(`${scriptUrl}/subdomain`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		}).catch(() => undefined)

		const subdomainRes = await fetch(`${CLOUDFLARE_API}/accounts/${accountId}/workers/subdomain`, {
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		})
		const subdomain = subdomainRes.ok
			? ((await subdomainRes.json().catch(() => ({}))) as { result?: { subdomain?: string } }).result
					?.subdomain
			: null

		if (!subdomain) {
			throw upstream(
				"Worker deployed but failed to retrieve workers.dev subdomain. Make sure you have setup a workers.dev subdomain in Cloudflare Dashboard.",
			)
		}

		const started: StartedDeployment & { url: string } = {
			id: projectName,
			state: "READY",
			url: `https://${projectName}.${subdomain}.workers.dev`,
		}
		return started
	},

	// Unreachable: `start` answers READY, so the use-case never polls.
	poll: async () => ({ state: "READY", url: null }),
}

const DENO_RELAY_CODE = `Deno.serve(async (request) => {
  const target = request.headers.get("x-relay-target");
  const relayPath = request.headers.get("x-relay-path") || "/";

  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const targetUrl = target.replace(/\\/$/, "") + relayPath;
  const newHeaders = new Headers(request.headers);
  newHeaders.delete("x-relay-target");
  newHeaders.delete("x-relay-path");
  newHeaders.delete("host");

  const init = {
    method: request.method,
    headers: newHeaders,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    const response = await fetch(targetUrl, init);
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
});`

/**
 * Deno Deploy v2 splits the work: an app is created, a revision is deployed into it, and
 * the address is derived from the org domain rather than reported. A revision that never
 * succeeds leaves an app behind under the operator's name, so the app is discarded on
 * failure.
 */
const deno: RelayProviderDeps = {
	start: async ({ token, projectName, fields }) => {
		const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
		const orgDomain = fields.orgDomain ?? ""

		const appRes = await fetch(`${DENO_API}/apps`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				slug: projectName,
				labels: { "custom.kind": "9router-relay" },
				config: { install: "deno install", runtime: { type: "dynamic", entrypoint: "main" } },
			}),
		})
		if (!appRes.ok) {
			if (appRes.status === 409) {
				throw upstream(`App "${projectName}" already exists. Choose a different name.`)
			}
			const text = await appRes.text().catch(() => "")
			throw upstream(`Failed to create app (${appRes.status}): ${text}`)
		}
		const app = (await appRes.json()) as { id?: string }
		const appId = String(app.id ?? "")

		const deployRes = await fetch(`${DENO_API}/apps/${appId}/deploy`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				assets: { main: { kind: "file", content: DENO_RELAY_CODE, encoding: "utf-8" } },
			}),
		})
		if (!deployRes.ok) {
			const text = await deployRes.text().catch(() => "")
			console.error("[ProxyPool][deno] deploy error:", deployRes.status, text)
			await fetch(`${DENO_API}/apps/${appId}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
			}).catch(() => undefined)
			throw upstream(`Deploy failed (${deployRes.status}): ${text}`)
		}
		const revision = (await deployRes.json()) as { id?: string; status?: string }

		const orgSlug = orgDomain.split(".")[0] ?? ""
		return {
			id: String(revision.id ?? ""),
			projectId: appId,
			state: revision.status ?? "queued",
			url: `https://${projectName}.${orgSlug}.deno.net`,
		}
	},

	// Deno reports readiness against the revision, not the app.
	poll: async ({ token, deploymentId }) => {
		const res = await fetch(`${DENO_API}/revisions/${deploymentId}`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		if (!res.ok) throw await providerError(res, "Failed to read Deno revision")
		const body = (await res.json()) as { status?: string }
		return { state: body.status ?? null, url: null }
	},

	discard: async ({ token, deployment }) => {
		if (!deployment.projectId) return
		await fetch(`${DENO_API}/apps/${deployment.projectId}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		})
	},
}

const netlify: RelayProviderDeps = {
	/**
	 * Netlify's deploy is content-addressed: create the deploy with the digests, then upload
	 * only the blobs it says it does not already have. Uploading unconditionally would fail on
	 * an unchanged function, and skipping the `required` check would upload a blob Netlify
	 * already stores under that hash.
	 */
	start: async ({ token, projectName }) => {
		const headers = { ...netlifyHeaders(token), "Content-Type": "application/json" }
		const create = await fetch(`${NETLIFY_API}/sites`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: projectName }),
		})
		if (!create.ok) {
			const message = await providerError(create, "Failed to create Netlify site")
			// 422 is Netlify's "that subdomain is taken"; 409 is what the screen can act on.
			if (create.status === 422) {
				throw conflict(
					`${message.message}. Site name "${projectName}" is taken — choose a different name.`,
				)
			}
			throw message
		}
		const site = (await create.json()) as {
			id?: string
			site_id?: string
			ssl_url?: string
			url?: string
		}
		const siteId = String(site.id ?? site.site_id ?? "")
		const siteUrl = String(site.ssl_url ?? site.url ?? "")

		const { zip, sha256 } = buildRelayFunctionZip()
		const { content: indexContent, sha1 } = buildIndexFile()

		const deployRes = await fetch(`${NETLIFY_API}/sites/${siteId}/deploys`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				files: { "/index.html": sha1 },
				functions: { [NETLIFY_FUNCTION_NAME]: sha256 },
			}),
		})
		if (!deployRes.ok) throw await providerError(deployRes, "Failed to create Netlify deploy")
		const deploy = (await deployRes.json()) as {
			id?: string
			state?: string
			required?: string[]
			required_functions?: string[]
		}
		const deployId = String(deploy.id ?? "")
		if (!deployId) throw upstream("Netlify deploy created but no deploy ID returned")

		const requiredFiles = new Set(deploy.required ?? [])
		const requiredFunctions = new Set(deploy.required_functions ?? [])
		const octets = { ...netlifyHeaders(token), "Content-Type": "application/octet-stream" }

		if (requiredFiles.has(sha1)) {
			const fileRes = await fetch(`${NETLIFY_API}/deploys/${deployId}/files/index.html`, {
				method: "PUT",
				headers: octets,
				body: Buffer.from(indexContent),
			})
			if (!fileRes.ok) throw await providerError(fileRes, "Failed to upload site file to Netlify")
		}

		if (requiredFunctions.has(sha256)) {
			const fnRes = await fetch(
				`${NETLIFY_API}/deploys/${deployId}/functions/${NETLIFY_FUNCTION_NAME}?runtime=js`,
				{ method: "PUT", headers: octets, body: zip },
			)
			if (!fnRes.ok) {
				throw await providerError(fnRes, "Failed to upload relay function to Netlify")
			}
		}

		return { id: deployId, projectId: siteId, state: deploy.state ?? "new", url: siteUrl }
	},

	poll: async ({ token, deploymentId }) => {
		const state = await pollDeployReady(deploymentId, token).catch((error: Error) => ({
			failed: true as const,
			error,
		}))
		if ("error" in state) throw upstream(state.error.message)
		return { state: "READY", url: null }
	},
}

const PROVIDERS: Record<RelayProvider, RelayProviderDeps> = { vercel, cloudflare, deno, netlify }

export function createDeployDeps(): DeployDeps {
	return {
		provider: (name) => PROVIDERS[name] ?? null,

		createPool: async (input) => {
			const pool = await createProxyPool(input)
			return {
				id: String(pool.id),
				type: String(pool.type ?? "http"),
				proxyUrl: String(pool.proxyUrl ?? ""),
				name: pool.name == null ? null : String(pool.name),
				noProxy: pool.noProxy == null ? null : String(pool.noProxy),
				isActive: pool.isActive === true,
				strictProxy: pool.strictProxy === true,
			}
		},

		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		now: () => Date.now(),
	}
}
