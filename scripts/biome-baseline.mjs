/**
 * Biome gate that fails only on NEW violations.
 *
 * The tree carries ~415 pre-existing a11y violations (useButtonType,
 * noLabelWithoutControl, keyboard handlers). They need real markup work per
 * site — a label needs an actual htmlFor target, a click handler needs a
 * keyboard equivalent — so a blanket autofix would be a behaviour change
 * masquerading as a lint fix. Fixing them is tracked separately.
 *
 * Meanwhile the gate must still catch anything new. So: count violations for
 * the files being checked, compare to a committed baseline, and fail on growth.
 * Run with --update to re-baseline after fixing some.
 *
 * Usage:
 *   node .codebuddy-tools/biome-baseline.mjs [--update] [file...]
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const BASELINE = path.join(ROOT, ".biome-baseline.json")
const UPDATE = process.argv.includes("--update")
const targets = process.argv.slice(2).filter((a) => !a.startsWith("--"))

function countViolations(paths) {
	const args = ["biome", "check", "--max-diagnostics=10000", ...paths]
	let output
	try {
		output = execFileSync("bunx", args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" })
	} catch (error) {
		output = `${error.stdout ?? ""}${error.stderr ?? ""}`
	}
	const found = output.match(/Found (\d+) error/)
	return found ? Number(found[1]) : 0
}

const scope = targets.length > 0 ? targets : ["."]
const actual = countViolations(scope)

const baseline = fs.existsSync(BASELINE)
	? JSON.parse(fs.readFileSync(BASELINE, "utf8"))
	: { total: actual }

if (UPDATE) {
	fs.writeFileSync(BASELINE, `${JSON.stringify({ total: actual }, null, 2)}\n`)
	console.log(`biome-baseline: recorded ${actual} violations`)
	process.exit(0)
}

if (actual > baseline.total) {
	console.error(
		`biome-baseline: ${actual} violations, baseline is ${baseline.total} — ${actual - baseline.total} NEW.`,
	)
	console.error("Fix the new ones, or re-baseline deliberately with --update.")
	process.exit(1)
}

console.log(`biome-baseline: ${actual} violations (baseline ${baseline.total}) — no regression.`)
