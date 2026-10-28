import { describe, it, expect } from "vitest";
import {
  applyProbe,
  effectiveThreshold,
  initialReachability,
  type ReachabilityState,
  type ReachabilityResult,
} from "@/app/(dashboard)/dashboard/endpoint/reachability";

/**
 * Locks the debounce rule both probe paths now share. The old code applied it
 * twice with different counter handling, so these cases pin the behaviour the
 * badge must have: one success is enough to recover, one failure is not enough to
 * go dark.
 */
const THRESHOLD = 5;

/** Run a sequence of probe outcomes through the fold, returning the visible trail. */
function trail(outcomes: boolean[], threshold = THRESHOLD, start: ReachabilityState = initialReachability()) {
  let state = start;
  let reachable = false;
  const visible: boolean[] = [];
  for (const ok of outcomes) {
    const result = applyProbe(state, ok, threshold, reachable) satisfies ReachabilityResult;
    state = result.state;
    reachable = result.reachable;
    visible.push(reachable);
  }
  return { visible, state };
}

describe("applyProbe", () => {
  it("recovers on the first success and clears the miss counter", () => {
    const result = applyProbe({ misses: 4, everReachable: false }, true, THRESHOLD, false);
    expect(result.reachable).toBe(true);
    expect(result.state.misses).toBe(0);
    expect(result.state.everReachable).toBe(true);
    expect(result.recovered).toBe(true);
  });

  it("does not report a second recovery once already reachable", () => {
    const result = applyProbe({ misses: 0, everReachable: true }, true, THRESHOLD, true);
    expect(result.recovered).toBe(false);
    expect(result.reachable).toBe(true);
  });

  it("keeps the previous verdict while failures are below the threshold", () => {
    const result = applyProbe({ misses: 2, everReachable: true }, false, THRESHOLD, true);
    expect(result.reachable).toBe(true);
    expect(result.state.misses).toBe(3);
  });

  it("goes unreachable exactly at the threshold", () => {
    const justBelow = applyProbe({ misses: THRESHOLD - 2, everReachable: true }, false, THRESHOLD, true);
    expect(justBelow.reachable).toBe(true);

    const atThreshold = applyProbe({ misses: THRESHOLD - 1, everReachable: true }, false, THRESHOLD, true);
    expect(atThreshold.reachable).toBe(false);
  });

  it("stays unreachable after the threshold is passed", () => {
    const result = applyProbe({ misses: THRESHOLD + 3, everReachable: true }, false, THRESHOLD, false);
    expect(result.reachable).toBe(false);
    expect(result.state.misses).toBe(THRESHOLD + 4);
  });

  it("does not clear everReachable on failure", () => {
    const result = applyProbe({ misses: 0, everReachable: true }, false, THRESHOLD, true);
    expect(result.state.everReachable).toBe(true);
  });
});

describe("a probe that changes nothing must not mint a new state", () => {
  /**
   * The page memoizes on the fold result, and the pollers write it on every tick. An
   * equal-but-fresh object per probe re-ran every effect that consumed it, including
   * the poll that produced it — that is what made the endpoint page fetch in a loop.
   * Identity is the contract, not just equality.
   */
  it("returns the same object when a success changes nothing", () => {
    const current: ReachabilityState = { misses: 0, everReachable: true };
    const result = applyProbe(current, true, THRESHOLD, true);
    expect(result.state).toBe(current);
    expect(result.recovered).toBe(false);
  });

  it("returns a new object when a success clears pending misses", () => {
    const current: ReachabilityState = { misses: 3, everReachable: true };
    const result = applyProbe(current, true, THRESHOLD, true);
    expect(result.state).not.toBe(current);
    expect(result.state.misses).toBe(0);
  });

  it("returns a new object when the first success sets everReachable", () => {
    const current: ReachabilityState = { misses: 0, everReachable: false };
    const result = applyProbe(current, true, THRESHOLD, false);
    expect(result.state).not.toBe(current);
    expect(result.recovered).toBe(true);
  });

  it("stays identity-stable across a run of healthy probes", () => {
    let state: ReachabilityState = { misses: 0, everReachable: true };
    const first = state;
    for (let i = 0; i < 10; i += 1) {
      state = applyProbe(state, true, THRESHOLD, true).state;
    }
    expect(state).toBe(first);
  });

  it("still counts every failure, because misses always change", () => {
    const current: ReachabilityState = { misses: 2, everReachable: true };
    expect(applyProbe(current, false, THRESHOLD, true).state).not.toBe(current);
  });
});

describe("effectiveThreshold", () => {
  it("never allows a zero or negative threshold", () => {
    expect(effectiveThreshold(0)).toBe(1);
    expect(effectiveThreshold(-3)).toBe(1);
    expect(effectiveThreshold(1)).toBe(1);
    expect(effectiveThreshold(5)).toBe(5);
  });
});

describe("trail", () => {
  it("survives a single blip without going dark", () => {
    const { visible } = trail([true, false, true, false, false, false, false]);
    // one success, then four failures — still under the threshold of five
    expect(visible.at(-1)).toBe(true);
  });

  it("goes dark only after five consecutive misses", () => {
    const { visible } = trail([true, false, false, false, false, false]);
    expect(visible).toEqual([true, true, true, true, true, false]);
  });

  it("recovers immediately when a probe succeeds again", () => {
    const { visible } = trail([true, false, false, false, false, false, true]);
    expect(visible.at(-1)).toBe(true);
  });

  it("counts misses from zero after a recovery", () => {
    const { visible, state } = trail([true, false, false, true, false, false, false, false]);
    expect(visible.at(-1)).toBe(true);
    expect(state.misses).toBe(4);
  });

  it("never reports reachable from a cold start without a success", () => {
    const { visible } = trail([false, false, false]);
    expect(visible).toEqual([false, false, false]);
  });
});

describe("matches the inline rule it replaces", () => {
  /**
   * The pre-refactor client-ping loop, verbatim, over the same probe sequence. A
   * success set reachable and bumped the counter to zero; a failure only applied
   * after REACHABLE_MISS_THRESHOLD consecutive misses.
   */
  function legacyTrail(outcomes: boolean[]) {
    let misses = 0;
    let reachable = false;
    let everReachable = false;
    const visible: boolean[] = [];
    for (const ok of outcomes) {
      if (ok) {
        misses = 0;
        reachable = true;
        everReachable = true;
      } else {
        misses += 1;
        if (misses >= THRESHOLD) reachable = false;
      }
      visible.push(reachable);
    }
    return { visible, misses, everReachable };
  }

  const SEQUENCES: boolean[][] = [
    [true],
    [false],
    [true, false],
    [true, false, false, false, false, false],
    [true, false, false, false, false, false, true],
    [false, false, false, false, false, true, false],
    [true, true, false, true, false, true],
    Array.from({ length: 20 }, (_, i) => i % 3 !== 0),
  ];

  for (const [index, sequence] of SEQUENCES.entries()) {
    it(`sequence ${index + 1}`, () => {
      const { visible, state } = trail(sequence);
      const legacy = legacyTrail(sequence);
      expect(visible).toEqual(legacy.visible);
      expect(state.misses).toBe(legacy.misses);
      expect(state.everReachable).toBe(legacy.everReachable);
    });
  }
});
