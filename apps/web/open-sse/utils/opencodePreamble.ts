/**
 * Rebuild the parts of the OpenCode preamble that the CLI writes per request.
 *
 * The captured harness is a frozen request. Three of its blocks are true only for
 * the moment of capture: which model was being called, what day it was, and which
 * directory the capturing machine ran in. Sent unchanged for any other model, the
 * system prompt contradicts the request body - it names `big-pickle` while the body
 * asks for something else - so these blocks are regenerated for every request.
 *
 * The formats are taken from the CLI binary (v2.1.4), not invented: the identity
 * plugin splices `# Your Model` at system index 1, and the `core/date` and
 * `core/environment` context providers render the other two.
 *
 * The static prose and the tool manifest are NOT rebuilt here. They are captured
 * artifacts that change only when OpenCode ships a new harness, and they arrive
 * through `loadAgentHarness()`.
 */

import { tmpdir } from "node:os"
import { join } from "node:path"

/** The provider id the CLI reports for its own free lane. */
const PROVIDER_ID = "opencode"

/** What the capture machine contributed; replaced with this machine's values. */
export interface PreambleEnvironment {
	readonly workingDirectory: string
	readonly workspaceRoot: string
	readonly isGitRepo: boolean
	readonly platform: string
	readonly tmpDirectory: string
}

/** Everything the three rebuilt blocks state about this request. */
export interface PreambleIdentity extends PreambleEnvironment {
	readonly modelName: string
	readonly modelID: string
	readonly today: Date
}

function modelBlock(identity: PreambleIdentity): string[] {
	return [
		"# Your Model",
		`- Name: ${identity.modelName}`,
		`- Provider ID: ${PROVIDER_ID}`,
		`- Model ID: ${identity.modelID}`,
	]
}

function dateBlock(identity: PreambleIdentity): string[] {
	return [`Today's date: ${identity.today.toDateString()}`]
}

function environmentBlock(identity: PreambleIdentity): string[] {
	return [
		"<env>",
		`  Working directory: ${identity.workingDirectory}`,
		`  Workspace root folder: ${identity.workspaceRoot}`,
		`  Is directory a git repo: ${identity.isGitRepo ? "yes" : "no"}`,
		`  Platform: ${identity.platform}`,
		`  Prefer ${identity.tmpDirectory} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
		"</env>",
	]
}

/** A half-open line range to replace, or null when the capture does not have it. */
type LineSpan = readonly [number, number]

/**
 * `# Your Model` plus the bullet lines under it.
 *
 * The bullets are consumed rather than "everything up to the next heading", so a
 * capture that puts something else between the two headings keeps that something.
 */
function modelSpan(lines: string[]): LineSpan | null {
	const start = lines.indexOf("# Your Model")
	if (start < 0) return null
	let end = start + 1
	while (end < lines.length && lines[end].startsWith("- ")) end++
	return [start, end]
}

function dateSpan(lines: string[]): LineSpan | null {
	const start = lines.findIndex((line) => line.startsWith("Today's date:"))
	return start < 0 ? null : [start, start + 1]
}

function environmentSpan(lines: string[]): LineSpan | null {
	const start = lines.findIndex((line) => line.trimEnd() === "<env>")
	if (start < 0) return null
	const close = lines.findIndex((line, index) => index > start && line.trimEnd() === "</env>")
	return close < 0 ? null : [start, close + 1]
}

/**
 * Swap one span for `block`, leaving the capture untouched when the span is absent.
 *
 * Absent is the expected state after an upstream harness change: the capture is a
 * different shape and the honest answer is to send it unmodified, not to guess
 * where the block should have been.
 */
function replaceSpan(lines: string[], span: LineSpan | null, block: string[]): string[] {
	if (!span) return lines
	const [start, end] = span
	return [...lines.slice(0, start), ...block, ...lines.slice(end)]
}

/** `captured` with the model, date and environment blocks restated for this request. */
export function composePreamble(captured: string, identity: PreambleIdentity): string {
	if (typeof captured !== "string" || !captured) return captured
	let lines = captured.split("\n")
	lines = replaceSpan(lines, modelSpan(lines), modelBlock(identity))
	lines = replaceSpan(lines, dateSpan(lines), dateBlock(identity))
	lines = replaceSpan(lines, environmentSpan(lines), environmentBlock(identity))
	return lines.join("\n")
}

/**
 * This machine's half of the identity.
 *
 * The directory reported is the CLI's own temp workspace, not the server's working
 * directory. The capture shows the CLI running in `/tmp/opencode/...`, so a temp
 * workspace is the plausible shape - and the deployment path is something the
 * outgoing preamble has never carried: it would name the operator's project to a
 * third party. `opencode-session.test.ts` pins that.
 */
export function environmentIdentity(): PreambleEnvironment {
	const workspace = join(tmpdir(), "opencode")
	return {
		workingDirectory: workspace,
		workspaceRoot: workspace,
		isGitRepo: false,
		platform: process.platform,
		tmpDirectory: workspace,
	}
}
