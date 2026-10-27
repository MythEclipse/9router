import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Usage page mirrors an SSE stream. Two things make it flicker, and both are
 * about *how much* is re-sent rather than how it is rendered:
 *
 *  1. The aggregates (`byModel`, `byAccount`, …) are a large map. A finished
 *     request changes exactly one bucket, but the old route re-sent the whole map
 *     on every tick — several times a second under load — so every table that
 *     reads them re-rendered and the page flashed.
 *  2. The cheap "pending" frame ALSO spread `stats` into itself, shipping the
 *     same map twice per tick.
 *
 * The live rows are small (20 entries) and must keep flowing, so they ride on a
 * frame that carries nothing else.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const route = readFileSync(
  join(REPO_ROOT, "src/app/api/usage/stream/route.ts"),
  "utf8",
);
const page = readFileSync(
  join(REPO_ROOT, "src/shared/components/UsageStats.tsx"),
  "utf8",
);

const LIVE_FRAME_MARK = '_type: "pending" })\\n\\n`);';
const GUARD = "if (signature === state.lastFullSignature) return;";

describe("usage stream frame budget", () => {
  it("suppresses a full frame whose totals did not move", () => {
    // Without this guard a per-request "update" re-sends every bucket.
    expect(route).toContain(GUARD);
    expect(route).toContain("state.lastFullSignature = signature;");
  });

  it("keys the signature on the aggregate totals, not only the request count", () => {
    expect(route).toContain("${stats.totalPromptTokens}");
    expect(route).toContain("${stats.totalCompletionTokens}");
    expect(route).toContain("${stats.totalCost}");
  });

  it("does not spread the aggregate map into the live frame", () => {
    // The offending shape was `{ ...state.cachedStats, ...` / `{ ...stats, ...`
    // inside the live frame.
    expect(route).not.toContain("...state.cachedStats, activeRequests");
    expect(route).not.toContain("...stats, activeRequests");
  });

  it("still sends the live rows even when the aggregates are suppressed", () => {
    // The live frame must be enqueued BEFORE the signature early-return,
    // otherwise a quiet aggregate means a frozen table.
    const lines = route.split("\n");
    const liveAt = lines.findIndex((l) => l.includes('_type: "pending"') && l.includes("enqueue"));
    const guardAt = lines.findIndex((l) => l.includes("lastFullSignature) return"));
    expect(liveAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(liveAt).toBeLessThan(guardAt);
  });

  it("does not seed page state from a live-only frame", () => {
    // Seeding from "pending" would leave every aggregate undefined.
    expect(page).toContain('data._type !== "full" && !statsSeeded.current');
  });

  it("keeps the previous stats object when a full frame repeats byte-for-byte", () => {
    expect(page).toContain("if (e.data === lastFrameRef.current) return prev;");
  });

  it("restarts the seed guard and de-dupe on a new stream connection", () => {
    expect(page).toContain("statsSeeded.current = false;");
    expect(page).toContain("lastFrameRef.current = null;");
  });
});
