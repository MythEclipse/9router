/**
 * Claude Desktop (Cowork mode) settings procedures.
 *
 * The plugin presets and the local stdio plugins are web constants — they describe which bridges
 * *this* dashboard can serve — so they are injected alongside the filesystem port instead of being
 * imported into `apps/api`. What stays here is the wiring: three verbs, one dependency bundle.
 */
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import { type AppContext, authed } from "../base.ts"

type CoworkHosts = NonNullable<AppContext["coworkSettingsHosts"]>

const hostsOf = (hosts: CoworkHosts | undefined): CoworkHosts => {
	if (!hosts) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "Cowork settings hosts are not wired into this client",
		})
	}
	return hosts
}

/** The dependency bundle the use-case needs, assembled from the injected host. */
const depsOf = (hosts: CoworkHosts) => ({
	port: hosts.files,
	pluginPresets: hosts.pluginPresets,
	localPlugins: hosts.localPlugins,
	buildPresetEntries: hosts.buildPresetEntries,
	localBridgePrefix: hosts.localBridgePrefix,
	cliTokenHeader: hosts.cliTokenHeader,
	cliToken: hosts.cliToken,
})

export const coworkSettingsRouter = {
	/** What the screen draws: installed?, the active config, and the three plugin lists. */
	readSettings: authed.handler(async ({ context }) =>
		context.useCases.coworkSettings.read(depsOf(hostsOf(context.coworkSettingsHosts))),
	),

	writeSettings: authed
		.input(z.object({ body: z.unknown() }))
		.handler(async ({ input, context }) =>
			context.useCases.coworkSettings.write(input.body, depsOf(hostsOf(context.coworkSettingsHosts))),
		),

	/** Reset the active entry by emptying it; see the use-case for why it is not deleted. */
	resetSettings: authed.handler(async ({ context }) =>
		context.useCases.coworkSettings.reset(depsOf(hostsOf(context.coworkSettingsHosts))),
	),
}
