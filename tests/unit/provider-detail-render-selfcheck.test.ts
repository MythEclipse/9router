import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the provider detail page's render self-check from the suite.
 *
 * The check needs a bundler and a React stub, so it lives in its own .mjs; running it
 * from here is what keeps it honest. This page is 2,100 lines with no error boundary,
 * so a dangling reference renders a blank provider screen.
 */
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const script = path.join(
  repoRoot,
  "src/app/(dashboard)/dashboard/providers/[id]/renderSelfCheck.mjs"
);

describe("provider detail page render self-check", () => {
  it("renders the page body without a dangling reference", () => {
    const out = execFileSync("node", [script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 180_000,
    });
    expect(out).toContain("checks passed");
    expect(out).not.toContain("FAIL");
  }, 200_000);
});
