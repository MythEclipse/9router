import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The live rows reach the dashboard from TWO independent readers, and the client
 * merges both:
 *
 *   - `getActiveRequests` builds them from the in-memory ring,
 *   - `getUsageStats` builds them straight from usageHistory.
 *
 * Only the first one was taught to read `meta.resolvedModel`. The second still
 * selected the raw `model` column, so every `_type:"full"` frame replaced the
 * correct rows with the requested name — a combo. On screen that looked like the
 * real model appearing for a moment and then reverting to the combo, which is
 * exactly the blinking being chased.
 *
 * Both readers must resolve the alias, or one of them keeps undoing the other.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const repo = readFileSync(join(REPO_ROOT, "src/lib/db/repos/usageRepo.ts"), "utf8");

/** Every `SELECT ... FROM usageHistory` that yields live rows (has both model and status). */
function recentRowQueries(source: string): string[] {
  return source
    .split("\n")
    .filter(
      (l) =>
        l.includes("FROM usageHistory") &&
        l.includes("SELECT") &&
        l.includes("model") &&
        l.includes("status") &&
        l.includes("tokens"),
    );
}

describe("every live-row reader resolves the alias", () => {
  it("selects meta wherever recent rows are read for display", () => {
    const queries = recentRowQueries(repo);
    expect(queries.length).toBeGreaterThanOrEqual(2);
    for (const q of queries) {
      expect(q).toContain("meta");
    }
  });

  it("maps the resolved model in the stats reader too, not just the ring", () => {
    // The ring reader already did this; the stats reader is the regression.
    const occurrences = repo.match(/model: resolved \|\| requested/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(1);
    const ringOccurrences = repo.match(/model: displayModel/g) ?? [];
    expect(ringOccurrences.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps the alias as a qualifier in the stats reader", () => {
    expect(repo).toContain("requestedModel: resolved ? requested : undefined,");
  });
});
