export { resolveTools, TOOL_IDS, TOOLS } from "./connectTools/registry.js"
export { CLAUDE_MODELS, claude, codex } from "./connectTools/toolsA.js"
export { crush, droid, opencode } from "./connectTools/toolsA2.js"
export { cline, kilo, omp, pi } from "./connectTools/toolsB.js"

import { stripTrailingCommas } from "./connectTools/shared.js"

export { stripTrailingCommas }
export const __test__ = { stripTrailingCommas }
