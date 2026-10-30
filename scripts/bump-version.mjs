// Semver bump driven by the commits about to be pushed.
//
// Rules (in precedence order), see push-flow-convention:
//   1. any `feat:` commit in the push range          -> major
//   2. otherwise >= 5 changed files                   -> minor
//   3. otherwise                                     -> patch
//
// Run manually (`bun run bump`) and by the lefthook pre-push hook. Safe to
// re-run: when the newest commit already carries exactly the bump this range
// asks for, the script exits 0 instead of bumping a second time.
//
// Every tracked manifest carrying a `version` moves together. Bumping only the
// root left apps/web on 4.2.0 for the whole 5.x line, and the dashboard read
// that file: the sidebar advertised v4.2.0 on a 5.0.7 release.
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** The commit message the bumped version must be committed under. */
const BUMP_SUBJECT = "chore: adjust package.json version (bump)"

/** Run git, returning stdout, or "" when the command fails. */
function git(args) {
	try {
		return execFileSync("git", args, {
			cwd: projectRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim()
	} catch {
		return ""
	}
}

/** Resolve the remote-tracking ref this branch pushes to. */
function upstreamRef(branch) {
	const configured = git([
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		`${branch}@{upstream}`,
	])
	if (configured) return configured
	return `origin/${branch}`
}

/** Subject lines of the commits in the push range, oldest first. */
function pendingSubjects(base, branch) {
	const range = base ? `${base}...${branch}` : branch
	return git(["log", "--format=%s", range])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
}

/** Repo-relative paths touched in the push range. */
function pendingFiles(base, branch) {
	const range = base ? `${base}...${branch}` : branch
	return git(["diff", "--name-only", range])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
}

/** Read a manifest by its repo-relative path. */
function readManifest(file) {
	return JSON.parse(readFileSync(resolve(projectRoot, file), "utf8"))
}

/**
 * Every tracked manifest that carries a version, root first.
 *
 * `git ls-files` is the source rather than a glob: it lists tracked files only,
 * so node_modules, .next and the standalone copy can never enter the sweep.
 */
function versionedManifests() {
	const manifests = git(["ls-files"])
		.split("\n")
		.filter((file) => file === "package.json" || file.endsWith("/package.json"))
		.filter((file) => typeof readManifest(file).version === "string")
	return manifests.sort((a, b) =>
		a === "package.json" ? -1 : b === "package.json" ? 1 : a.localeCompare(b),
	)
}

/** Write `version` into one manifest without reformatting the rest of it. */
function writeVersion(file, version) {
	const path = resolve(projectRoot, file)
	const original = readFileSync(path, "utf8")
	const pkg = JSON.parse(original)
	if (pkg.version === version) return false
	// A bump commit that also reformats a manifest hides the one number it was
	// supposed to change. Refuse rather than produce that diff.
	if (`${JSON.stringify(pkg, null, 2)}\n` !== original) {
		throw new Error(`${file} is not canonical 2-space JSON — format it before bumping`)
	}
	pkg.version = version
	writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
	return true
}

function bumpKind(subjects, files) {
	if (subjects.some((subject) => /^feat(\(|:)/.test(subject))) return "major"
	return files.length >= 5 ? "minor" : "patch"
}

function nextVersion(current, kind) {
	const [major, minor, patch] = current.split(".").map(Number)
	if ([major, minor, patch].some((part) => Number.isNaN(part))) {
		throw new Error(`Unparsable version in package.json: ${current}`)
	}
	if (kind === "major") return `${major + 1}.0.0`
	if (kind === "minor") return `${major}.${minor + 1}.0`
	return `${major}.${minor}.${patch + 1}`
}

/**
 * True when HEAD is the bump commit for this very range — same message, and the
 * only files it touched are the manifests the bump owns. Anything else (a real
 * commit stacked on top, or a bump that also carried edits) means the range has
 * grown since the last bump and owes a new one.
 *
 * This cannot compare against `target`: that value is derived from the current
 * version, so it is never equal to it.
 */
function bumpAlreadyApplied(branch, manifests) {
	if (git(["log", "-1", "--format=%s", branch]) !== BUMP_SUBJECT) return false
	return git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD", branch])
		.split("\n")
		.filter(Boolean)
		.every((file) => manifests.includes(file))
}

function main() {
	const manifests = versionedManifests()
	const current = readManifest("package.json").version

	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"])
	if (!branch || branch === "HEAD") {
		console.error("[bump] Detached HEAD — cannot determine what is being pushed. Skipping.")
		process.exit(0)
	}

	const base = upstreamRef(branch)
	if (!git(["rev-parse", "--verify", "--quiet", base])) {
		// The branch has never been pushed. There is no range to compare against, so any
		// bump here would be guessed from the entire history - and since that history holds
		// `feat:` commits, the guess would be a major bump for a first push. Nothing to do.
		console.log(`[bump] No upstream ${base} yet - first push of this branch. Skipping.`)
		return
	}

	const subjects = pendingSubjects(base, branch)
	const files = pendingFiles(base, branch)
	const kind = bumpKind(subjects, files)

	// Re-bumping an already-bumped range would skip a release number, and the
	// pre-push hook always runs after the bump commit was made.
	if (bumpAlreadyApplied(branch, manifests)) {
		console.log(
			`[bump] HEAD is already the bump commit for this range (${subjects.length} pending commit(s), ${files.length} changed file(s) vs ${base}). No change.`,
		)
		return
	}

	const target = nextVersion(current, kind)
	const written = manifests.filter((file) => writeVersion(file, target))

	console.log(
		`[bump] ${current} -> ${target} (${kind}) — ${written.length}/${manifests.length} manifest(s)`,
	)
	for (const file of written) console.log(`[bump]   ${file}`)
	console.log(
		`[bump] ${subjects.length} pending commit(s), ${files.length} changed file(s) vs ${base}`,
	)
	for (const subject of subjects) console.log(`[bump]   - ${subject}`)

	// Commit it here rather than printing an instruction. The hook runs on pre-push:
	// the push is already in flight, so a version left in the working tree ships as
	// the OLD number and stays behind as dirt that the next push bumps again from the
	// stale base. An unstaged bump is an unshipped bump.
	execFileSync("git", ["add", ...manifests], {
		cwd: projectRoot,
		stdio: ["ignore", "ignore", "inherit"],
	})
	execFileSync("git", ["commit", "-m", BUMP_SUBJECT, "--no-verify"], {
		cwd: projectRoot,
		stdio: ["ignore", "ignore", "inherit"],
	})
	console.log(`[bump] Committed ${target} as "${BUMP_SUBJECT}".`)
}

main()
