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

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
