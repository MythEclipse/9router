import "server-only"

import type { DispatchDeps, SessionView } from "9router-api/application/oauth/dispatch-actions"
import { detectIdeInstalled } from "@/lib/oauth/utils/ideDetect"
import {
	clearCodexSession,
	clearTraeSession,
	clearWindsurfSession,
	clearXaiSession,
	clearXiaomiMimoSession,
	clearZedSession,
	getCodexSessionStatus,
	getTraeSessionStatus,
	getWindsurfSessionStatus,
	getXaiSessionStatus,
	getXiaomiMimoSessionStatus,
	getZedSessionStatus,
	stopCodexProxy,
	stopTraeProxy,
	stopWindsurfProxy,
	stopXaiProxy,
	stopXiaomiMimoProxy,
	stopZedProxy,
} from "@/lib/oauth/utils/server"

/**
 * The OAuth session stores, one per provider.
 *
 * Each provider keeps its own in-process map of login sessions; this is the table that turns a
 * slug into the right one, replacing six parallel `if (provider === ...)` chains that had to be
 * kept in step by hand. A provider missing from the table is refused by the use-case before it
 * gets here, so these lookups can assume the entry exists.
 */
const SESSIONS: Record<
	string,
	{
		readonly read: (state: string) => SessionView | null
		readonly clear: (state: string) => void
		readonly stop: () => void
	}
> = {
	codex: {
		read: (state) => getCodexSessionStatus(state) as SessionView | null,
		clear: clearCodexSession,
		stop: stopCodexProxy,
	},
	xai: {
		read: (state) => getXaiSessionStatus(state) as SessionView | null,
		clear: clearXaiSession,
		stop: stopXaiProxy,
	},
	trae: {
		read: (state) => getTraeSessionStatus(state) as SessionView | null,
		clear: clearTraeSession,
		stop: stopTraeProxy,
	},
	windsurf: {
		read: (state) => getWindsurfSessionStatus(state) as SessionView | null,
		clear: clearWindsurfSession,
		stop: stopWindsurfProxy,
	},
	zed: {
		read: (state) => getZedSessionStatus(state) as SessionView | null,
		clear: clearZedSession,
		stop: stopZedProxy,
	},
	"xiaomi-mimo": {
		read: (state) => getXiaomiMimoSessionStatus(state) as SessionView | null,
		clear: clearXiaomiMimoSession,
		stop: stopXiaomiMimoProxy,
	},
}

/** What the dispatcher's session actions reach on this machine. */
export function oauthSessionDeps(): DispatchDeps {
	return {
		readSession: (provider, state) => SESSIONS[provider]?.read(state) ?? null,
		clearSession: (provider, state) => SESSIONS[provider]?.clear(state),
		stopProxy: (provider) => SESSIONS[provider]?.stop(),
		detectIde: (provider) => detectIdeInstalled(provider),
	}
}
