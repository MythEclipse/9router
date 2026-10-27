/**
 * Reachability tracking for a tunnel endpoint.
 *
 * Both the tunnel and Tailscale are polled from two sources — the server's status
 * endpoint and a direct browser ping — and either can flap. Two rules keep that
 * from turning the badge into a strobe light:
 *
 *   - a *recovery* is applied on the first positive probe, and
 *   - a *failure* is only applied after `threshold` consecutive negative probes.
 *
 * The component used to apply those two rules in two separate places (the server
 * sync path and the browser ping path), and they drifted: one of them reset the
 * miss counter on recovery and the other forgot to, so a flapping tunnel could
 * report "reachable" forever after a single success. This module owns the rule so
 * both paths share it.
 */

/** The mutable state a tracker keeps between probes. */
export interface ReachabilityState {
  /** Consecutive negative probes since the last recovery. */
  misses: number;
  /** Whether the endpoint has ever been reachable this session. */
  everReachable: boolean;
}

/** A fresh tracker: never probed, never reachable. */
export function initialReachability(): ReachabilityState {
  return { misses: 0, everReachable: false };
}

/** The outcome of one probe. */
export interface ReachabilityResult {
  state: ReachabilityState;
  /** Whether the caller should treat the endpoint as reachable right now. */
  reachable: boolean;
  /** Whether `everReachable` flipped false → true on this probe. */
  recovered: boolean;
}

/**
 * Fold one probe into the tracker.
 *
 * `reachable` is applied on the first success. A failure only takes effect once
 * `misses` reaches `threshold`, so a single dropped packet does not blank the URL.
 *
 * @param current the tracker state before this probe
 * @param ok this probe's outcome
 * @param threshold consecutive failures required to call it unreachable
 * @param wasReachable the reachability currently rendered
 */
export function applyProbe(
  current: ReachabilityState,
  ok: boolean,
  threshold: number,
  wasReachable: boolean
): ReachabilityResult {
  if (ok) {
    return {
      state: { misses: 0, everReachable: true },
      reachable: true,
      recovered: !current.everReachable,
    };
  }

  const misses = current.misses + 1;
  const unreachableNow = misses >= threshold;
  return {
    state: { misses, everReachable: current.everReachable },
    // Below the threshold the previous verdict stands.
    reachable: unreachableNow ? false : wasReachable,
    recovered: false,
  };
}

/** The effective grace period; a non-positive threshold would flicker, so clamp to 1. */
export function effectiveThreshold(threshold: number): number {
  return threshold >= 1 ? threshold : 1;
}
