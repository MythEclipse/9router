export {
	Cancelled,
	extractAuthCookie,
	getOrCreateApiKey,
	loadSavedPassword,
	login,
	maskKey,
	normalizeServerUrl,
	parseArgs,
	prompt,
	promptPassword,
	request,
	savedEnvPath,
	savePassword,
} from "./connect/auth.js"

import {
	Cancelled,
	extractAuthCookie,
	loadSavedPassword,
	maskKey,
	normalizeServerUrl,
	parseArgs,
	savedEnvPath,
} from "./connect/auth.js"

export { run, runConnect } from "./connect/flow.js"
export const __test__ = {
	parseArgs,
	normalizeServerUrl,
	extractAuthCookie,
	maskKey,
	Cancelled,
	loadSavedPassword,
	savedEnvPath,
}
