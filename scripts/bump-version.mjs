// Semver bump driven by the commits about to be pushed.
//
// Rules (in precedence order), see push-flow-convention:
//   1. any `feat:` commit in the push range          -> major
//   2. otherwise >= 5 changed files                   -> minor
//   3. otherwise                                     -> patch
//
// Run manually (`pnpm run bump`) and by the lefthook pre-push hook. Safe to
// re-run: when the newest commit already carries exactly the bump this range
// asks for, the script exits 0 instead of bumping a second time.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The commit message the bumped version must be committed under. */
const BUMP_SUBJECT = "chore: adjust package.json version (bump)";

/** Run git, returning stdout, or "" when the command fails. */
function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Resolve the remote-tracking ref this branch pushes to. */
function upstreamRef(branch) {
  const configured = git([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    `${branch}@{upstream}`,
  ]);
  if (configured) return configured;
  return `origin/${branch}`;
}

/** Subject lines of the commits in the push range, oldest first. */
function pendingSubjects(base, branch) {
  const range = base ? `${base}...${branch}` : branch;
  return git(["log", "--format=%s", range])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Repo-relative paths touched in the push range. */
function pendingFiles(base, branch) {
  const range = base ? `${base}...${branch}` : branch;
  return git(["diff", "--name-only", range])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function bumpKind(subjects, files) {
  if (subjects.some((subject) => /^feat(\(|:)/.test(subject))) return "major";
  return files.length >= 5 ? "minor" : "patch";
}

function nextVersion(current, kind) {
  const [major, minor, patch] = current.split(".").map(Number);
  if ([major, minor, patch].some((part) => Number.isNaN(part))) {
    throw new Error(`Unparsable version in package.json: ${current}`);
  }
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * True when HEAD is the bump commit for this very range — same message, and
 * package.json is the only file it touched. Anything else (a real commit
 * stacked on top, or a bump that also carried edits) means the range has grown
 * since the last bump and owes a new one.
 *
 * This cannot compare against `target`: that value is derived from the current
 * version, so it is never equal to it.
 */
function bumpAlreadyApplied(branch) {
  if (git(["log", "-1", "--format=%s", branch]) !== BUMP_SUBJECT) return false;
  return git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD", branch])
    .split("\n")
    .filter(Boolean)
    .every((file) => file === "package.json");
}

function main() {
  const pkgPath = resolve(projectRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const current = pkg.version;

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    console.error("[bump] Detached HEAD — cannot determine what is being pushed. Skipping.");
    process.exit(0);
  }

  const base = upstreamRef(branch);
  if (!git(["rev-parse", "--verify", "--quiet", base])) {
    console.error(`[bump] No upstream ${base} — cannot compute the push range. Skipping.`);
    process.exit(1);
  }

  const subjects = pendingSubjects(base, branch);
  const files = pendingFiles(base, branch);
  const kind = bumpKind(subjects, files);

  // Re-bumping an already-bumped range would skip a release number, and the
  // pre-push hook always runs after the bump commit was made.
  if (bumpAlreadyApplied(branch)) {
    console.log(
      `[bump] HEAD is already the bump commit for this range (${subjects.length} pending commit(s), ${files.length} changed file(s) vs ${base}). No change.`,
    );
    return;
  }

  const target = nextVersion(current, kind);
  pkg.version = target;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  console.log(`[bump] ${current} -> ${target} (${kind})`);
  console.log(
    `[bump] ${subjects.length} pending commit(s), ${files.length} changed file(s) vs ${base}`,
  );
  for (const subject of subjects) console.log(`[bump]   - ${subject}`);
  console.log(`[bump] Commit the new version as: "${BUMP_SUBJECT}"`);
}

main();
