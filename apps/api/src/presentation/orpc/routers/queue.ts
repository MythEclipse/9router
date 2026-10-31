import { authed } from "../base.ts"

/**
 * What the gateway's own concurrency bound is doing right now.
 *
 * One number matters to an operator: the retry-after it would hand a caller arriving at this
 * instant. `null` there means the mean service time is not known yet — a fresh process has
 * completed nothing, and a made-up ETA is worse than an honest blank.
 */
export const queueRouter = {
	status: authed.handler(async ({ context }) => context.useCases.admission.snapshot()),
}
