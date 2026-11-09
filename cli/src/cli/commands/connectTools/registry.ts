import { claude, codex } from "./toolsA.js"
import { crush, droid, opencode } from "./toolsA2.js"
import { cline, kilo, omp, pi } from "./toolsB.js"

const TOOLS = [claude, codex, opencode, droid, crush, kilo, cline, pi, omp]
const TOOL_IDS = TOOLS.map((t) => t.id)
const TOOL_ALIASES = {
	"claude-code": "claude",
	claudecode: "claude",
	factory: "droid",
	kilocode: "kilo",
	"pi-coding-agent": "pi",
	"oh-my-pi": "omp",
}

function resolveTools(list) {
	const ids = new Set()
	for (const raw of list) {
		const id = String(raw).trim().toLowerCase()
		if (!id) continue
		if (id === "all") {
			TOOL_IDS.forEach((t) => ids.add(t))
			continue
		}
		const real = TOOL_ALIASES[id] || id
		if (!TOOL_IDS.includes(real))
			throw new Error(`Unknown tool "${raw}". Supported: ${TOOL_IDS.join(", ")}, all`)
		ids.add(real)
	}
	return TOOLS.filter((t) => ids.has(t.id))
}

export { resolveTools, TOOL_IDS, TOOLS }
