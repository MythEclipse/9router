import { describe, it, expect } from "vitest";
import { exposureStateOf, type ExposureState } from "@/app/(dashboard)/dashboard/endpoint/components/ExposureControl";

/**
 * The state chart both exposure options render through. Before the extraction each
 * option carried its own copy of these conditionals, so this table is the contract
 * that keeps them identical. The ordering matters: "enabled but not reachable" must
 * win over "loading", exactly as the nested ternaries it replaces did.
 */
type Flags = Parameters<typeof exposureStateOf>[0];

const base: Flags = { enabled: false, loading: false, reachable: false };

describe("exposureStateOf", () => {
  const cases: Array<[string, Flags, ExposureState]> = [
    // ready: enabled, settled, reachable
    ["enabled and reachable", { ...base, enabled: true, reachable: true }, "ready"],
    // degraded: enabled but not reachable. The enabled branch is tested before the
    // loading branch, so a stale reachable=true must not resurrect the URL while a
    // stop/disable is in flight.
    ["enabled, settled, not reachable", { ...base, enabled: true, reachable: false }, "degraded"],
    ["enabled and loading with reachable", { ...base, enabled: true, loading: true, reachable: true }, "connecting"],
    ["enabled and loading without reachable", { ...base, enabled: true, loading: true, reachable: false }, "connecting"],
    // connecting: a command in flight, or the tailscale connect step
    ["loading", { ...base, loading: true }, "connecting"],
    ["connecting flag", { ...base, connecting: true }, "connecting"],
    ["loading with a stale reachable", { ...base, loading: true, reachable: true }, "connecting"],
    // error
    ["error", { ...base, hasError: true }, "error"],
    ["error while checking", { ...base, hasError: true, checking: true }, "error"],
    // checking
    ["checking", { ...base, checking: true }, "checking"],
    // idle
    ["cold start", base, "idle"],
    ["disabled but reachable is stale", { ...base, reachable: true }, "idle"],
  ];

  for (const [label, flags, expected] of cases) {
    it(label, () => {
      expect(exposureStateOf(flags)).toBe(expected);
    });
  }
});

describe("agrees with the nested ternaries it replaces", () => {
  /**
   * The tunnel row as it was written inline, before the extraction. Every flag
   * combination is enumerated below so the extraction is proven, not assumed.
   */
  function legacyTunnelState(f: Flags): ExposureState {
    if (f.enabled && !f.loading && f.reachable) return "ready";
    if (f.enabled && !f.loading && !f.reachable) return "degraded";
    if (f.loading) return "connecting";
    if (f.hasError) return "error";
    if (f.checking) return "checking";
    return "idle";
  }

  /** The tailscale row as it was written inline: identical, plus the connect flag. */
  function legacyTailscaleState(f: Flags): ExposureState {
    if (f.enabled && !f.loading && f.reachable) return "ready";
    if (f.enabled && !f.loading && !f.reachable) return "degraded";
    if (f.loading || f.connecting) return "connecting";
    if (f.hasError) return "error";
    if (f.checking) return "checking";
    return "idle";
  }

  it("matches across all 128 flag combinations", () => {
    const bools = [false, true];
    let checked = 0;
    for (const enabled of bools)
      for (const loading of bools)
        for (const reachable of bools)
          for (const connecting of bools)
            for (const checking of bools)
              for (const hasError of bools) {
                for (const withConnecting of [false, true]) {
                  const flags: Flags = {
                    enabled, loading, reachable, checking, hasError,
                    // The tunnel row never consumed `connecting`; the tailscale row did,
                    // so both variants are compared against their own legacy shape.
                    ...(withConnecting ? { connecting } : {}),
                  };
                  const expected = withConnecting
                    ? legacyTailscaleState(flags)
                    : legacyTunnelState(flags);
                  expect(exposureStateOf(flags)).toBe(expected);
                  checked += 1;
                }
              }
    expect(checked).toBe(128);
  });
});
