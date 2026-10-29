/**
 * Tunnel procedures — the Cloudflare quick tunnel and Tailscale.
 *
 * Every answer here is a fact about this machine's own networking, which is why the whole
 * namespace is behind the password session: an API key can serve traffic, it cannot decide
 * where that traffic is exposed.
 *
 * `tailscaleInstall` is the one exception to "a procedure returns data". Installing
 * Tailscale streams its progress, and a stream is transport, so only the *decision* lives
 * here — `prepare` refuses a request with no password, before any byte of SSE is committed,
 * so the form gets a 400 it can render instead of an event nobody styled. The stream itself
 * stays in the route.
 */
import { z } from "zod"
import { authed } from "../base.ts"

export const tunnelRouter = {
	/** Cloudflare's tunnel state, Tailscale's state, and the download link. */
	status: authed.handler(async ({ context }) => context.useCases.tunnel.status()),

	/** Turn the Cloudflare quick tunnel on. */
	enable: authed.handler(async ({ context }) => context.useCases.tunnel.enable()),

	/** Turn it off. */
	disable: authed.handler(async ({ context }) => context.useCases.tunnel.disable()),

	tailscale: {
		/** Whether Tailscale is installed and signed in, and what to do when it is not. */
		check: authed.handler(async ({ context }) => context.useCases.tunnel.tailscaleCheck()),

		enable: authed.handler(async ({ context }) => context.useCases.tunnel.tailscaleEnable()),

		disable: authed.handler(async ({ context }) => context.useCases.tunnel.tailscaleDisable()),

		/**
		 * Refuse or accept an install, answering what the stream would need.
		 *
		 * The password is checked here so a refusal is a 400 with a message; the route takes
		 * the answer and only then opens the stream.
		 */
		prepareInstall: authed
			.input(z.record(z.string(), z.unknown()).optional())
			.handler(async ({ input, context }) =>
				context.useCases.tunnel.tailscaleInstall.prepare(input ?? {}),
			),
	},
}

export type TunnelRouter = typeof tunnelRouter
