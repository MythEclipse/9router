/**
 * The translator inspector's procedures.
 *
 * Both verbs are filesystem work over a caller-supplied name, so the store comes from the host and
 * the closed name rule from the domain; neither is imported here. `console-logs` stays a route —
 * it is an in-process log buffer, not a decision this layer can make.
 */
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import { type AppContext, authed } from "../base.ts"

type DumpStore = NonNullable<AppContext["translatorDumpStore"]>

const storeOf = (store: DumpStore | undefined): DumpStore => {
	if (!store) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "The translator dump store is not wired into this client",
		})
	}
	return store
}

export const translatorRouter = {
	/** One capture. `file` is refused by name before the store is asked for anything. */
	load: authed
		.input(z.object({ file: z.string().nullish() }))
		.handler(async ({ input, context }) =>
			context.useCases.translator.load(
				input.file,
				context.translatorDumpName,
				storeOf(context.translatorDumpStore),
			),
		),

	/** Write one capture. */
	save: authed
		.input(z.object({ body: z.unknown() }))
		.handler(async ({ input, context }) =>
			context.useCases.translator.save(
				input.body,
				context.translatorDumpName,
				storeOf(context.translatorDumpStore),
			),
		),
}
