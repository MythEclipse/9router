import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Usage page mirrors an SSE stream. What made it flash was not how the rows
 * were rendered but *how much* was re-sent: the aggregates (`byModel`,
 * `byAccount`, …) are a large map, and the route pushed the whole thing once per
 * finished request — ~5 frames a second under real load. Every table reading it
 * re-rendered, so the page never sat still.
 *
 * Two invariants keep it calm:
 *  - the aggregate map is paced by wall-clock, since totals move on every request
 *    and comparing them dedupes nothing;
 *  - the 20 live rows still ride every tick, on a frame carrying nothing else, so
 *    the table keeps moving while the map is quiet.
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

const lines = route.split("\n");
const indexOfLine = (predicate: (line: string) => boolean) => lines.findIndex(predicate);

describe("usage stream frame budget", () => {
  it("paces the aggregate frame by time rather than by total movement", () => {
    // Totals change on every request, so a totals-based guard suppresses nothing.
    expect(route).toContain("FULL_FRAME_MIN_INTERVAL_MS");
    expect(route).toMatch(/now - state\.lastFullAt < FULL_FRAME_MIN_INTERVAL_MS\) return;/);
    expect(route).toMatch(/state\.lastFullAt = now;/);
  });

  it("keeps the pacing interval short enough to look live", () => {
    const declared = route.match(/FULL_FRAME_MIN_INTERVAL_MS = (\d+)/);
    expect(declared).not.toBeNull();
    const ms = Number(declared?.[1]);
    // Long enough to stop the storm, short enough that the summary still feels live.
    expect(ms).toBeGreaterThanOrEqual(1000);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it("enqueues the live rows before the aggregate frame is throttled", () => {
    // If the throttle came first, a quiet map would freeze the table.
    const liveAt = indexOfLine((l) => l.includes('_type: "pending"') && l.includes("enqueue"));
    const throttleAt = indexOfLine((l) => l.includes("lastFullAt < FULL_FRAME_MIN_INTERVAL_MS"));
    expect(liveAt).toBeGreaterThan(-1);
    expect(throttleAt).toBeGreaterThan(-1);
    expect(liveAt).toBeLessThan(throttleAt);
  });

  it("does not spread the aggregate map into the live frame", () => {
    // Shipping the map twice per tick was half the problem.
    expect(route).not.toContain("...state.cachedStats, activeRequests");
    expect(route).not.toContain("...stats, activeRequests");
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
