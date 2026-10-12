// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào pass(baseline) → fail(now). Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));

// vitest reports absolute paths, e.g. /home/code/9router/tests/unit/foo.test.js.
// known-fails.txt keys are repo-relative ("tests/unit/foo.test.js :: name"), so
// strip everything up to and including the tests/ dir. Do NOT use a fixed
// split("/app/") — that assumed a container layout and yields `undefined` on a
// GitHub runner (/home/runner/work/...), which makes every known failure look
// like a regression.
const relPath = (abs) => {
  const p = abs.split("\\").join("/");
  const i = p.lastIndexOf("/tests/");
  return i === -1 ? p : p.slice(i + 1); // keep the leading "tests/..."
};

const nowFails = r.testResults.flatMap(f =>
  f.assertionResults.filter(a => a.status === "failed")
    .map(a => relPath(f.name) + " :: " + a.fullName)
);

// A file can fail WITHOUT any failing assertion: collection errors ("Cannot
// find package", "No test suite found in file") mark testResults[].status as
// "failed" while leaving assertionResults empty. Counting only assertions let
// those through silently — a suite could report 0 failures with whole files
// broken. Surface them as `file :: <status> - <message>` so they are gated too.
const nowFileFails = r.testResults
  .filter(f => f.status === "failed" && !(f.assertionResults || []).some(a => a.status === "failed"))
  .map(f => relPath(f.name) + " :: [collection] " + (f.message || "unknown collection error").split("\n")[0].trim());

const allFails = [...nowFails, ...nowFileFails];

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = allFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${allFails.length} [${nowFails.length} assertion, ${nowFileFails.length} collection], baseline known=${knownFails.size}, all known)`);
