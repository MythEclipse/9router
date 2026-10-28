// Debug logging utility - only active in dev mode (NODE_ENV !== "production")
// Outputs are tagged with [DBG:tag] for easy grep/filter
import { formatClockTime } from "./timeFormat.ts"

const isDev = process.env.NODE_ENV !== "production"

function ts() {
	return formatClockTime()
}

export function dbg(tag, msg) {
	if (!isDev) return
	console.log(`[${ts()}] 🐛 [DBG:${tag}] ${msg}`)
}

export const isDebugEnabled = isDev
