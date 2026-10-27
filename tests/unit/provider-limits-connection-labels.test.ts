import { describe, it, expect } from "vitest";
import {
  kiroMethodLabel,
  getConnectionSecondaryLabel,
  kiroRegion,
  getCodexResetCreditCount,
  formatClaudeResetClears,
  claudeGrantStatus,
  providerLabel,
  formatCreditDate,
  formatTimeRemaining,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/connectionLabels";

describe("kiroMethodLabel", () => {
  it("maps each known auth method", () => {
    expect(kiroMethodLabel({ providerSpecificData: { authMethod: "builder-id" } })).toBe("AWS Builder ID");
    expect(kiroMethodLabel({ providerSpecificData: { authMethod: "idc" } })).toBe("IAM Identity Center");
    expect(kiroMethodLabel({ providerSpecificData: { authMethod: "google" } })).toBe("Google");
    expect(kiroMethodLabel({ providerSpecificData: { authMethod: "github" } })).toBe("GitHub");
    expect(kiroMethodLabel({ providerSpecificData: { authMethod: "imported" } })).toBe("Imported Token");
    expect(kiroMethodLabel({ providerSpecificData: { authMethod: "api_key" } })).toBe("API Key");
  });

  it("falls back to the auth type when the method is unknown", () => {
    expect(kiroMethodLabel({ providerSpecificData: { authMethod: "wat" }, authType: "api_key" })).toBe("API Key");
    expect(kiroMethodLabel({ providerSpecificData: { authMethod: "wat" }, authType: "oauth" })).toBe("OAuth");
  });

  it("defaults to OAuth when nothing is known", () => {
    expect(kiroMethodLabel({})).toBe("OAuth");
    expect(kiroMethodLabel(null)).toBe("OAuth");
  });
});

describe("getConnectionSecondaryLabel", () => {
  it("shows the email when the name differs", () => {
    expect(getConnectionSecondaryLabel({ name: "Work", email: "work@x.io" })).toBe("work@x.io");
  });

  it("does not repeat a name that already equals the email", () => {
    expect(getConnectionSecondaryLabel({ name: "work@x.io", email: "work@x.io" })).toBeNull();
  });

  it("prefers the email over the display name", () => {
    expect(
      getConnectionSecondaryLabel({ name: "Work", email: "work@x.io", displayName: "Work Team" })
    ).toBe("work@x.io");
  });

  it("falls back to the display name when there is no email", () => {
    expect(getConnectionSecondaryLabel({ name: "Work", displayName: "Work Team" })).toBe("Work Team");
  });

  it("does not repeat a name that already equals the display name", () => {
    expect(getConnectionSecondaryLabel({ name: "Work Team", displayName: "Work Team" })).toBeNull();
  });

  it("returns null without a name or without anything to add", () => {
    expect(getConnectionSecondaryLabel({ email: "x@y.z" })).toBeNull();
    expect(getConnectionSecondaryLabel({ name: "Work" })).toBeNull();
    expect(getConnectionSecondaryLabel({ name: "  ", email: "x@y.z" })).toBeNull();
    expect(getConnectionSecondaryLabel(null)).toBeNull();
  });
});

describe("kiroRegion", () => {
  it("uses the stored region", () => {
    expect(kiroRegion({ providerSpecificData: { region: "eu-west-1" } })).toBe("eu-west-1");
  });

  it("recovers the region from the profile ARN when none is stored", () => {
    expect(
      kiroRegion({
        providerSpecificData: {
          profileArn: "arn:aws:codewhisperer:ap-southeast-1:123456789012:profile/ABC",
        },
      })
    ).toBe("ap-southeast-1");
  });

  it("returns an empty string when neither is available", () => {
    expect(kiroRegion({ providerSpecificData: {} })).toBe("");
    expect(kiroRegion({})).toBe("");
    expect(kiroRegion(null)).toBe("");
  });

  it("returns an empty string for a malformed ARN", () => {
    expect(kiroRegion({ providerSpecificData: { profileArn: "not-an-arn" } })).toBe("");
    expect(kiroRegion({ providerSpecificData: { profileArn: 12345 } })).toBe("");
  });
});

describe("getCodexResetCreditCount", () => {
  it("reads the available count", () => {
    expect(getCodexResetCreditCount({ raw: { resetCredits: { availableCount: 3 } } })).toBe(3);
  });

  it("accepts a numeric string", () => {
    expect(getCodexResetCreditCount({ raw: { resetCredits: { availableCount: "2" } } })).toBe(2);
  });

  it("clamps negatives to zero", () => {
    expect(getCodexResetCreditCount({ raw: { resetCredits: { availableCount: -5 } } })).toBe(0);
  });

  it("returns zero for missing or unparseable values", () => {
    expect(getCodexResetCreditCount({})).toBe(0);
    expect(getCodexResetCreditCount(null)).toBe(0);
    expect(getCodexResetCreditCount({ raw: { resetCredits: { availableCount: "abc" } } })).toBe(0);
    expect(getCodexResetCreditCount({ raw: { resetCredits: { availableCount: null } } })).toBe(0);
  });
});

describe("formatClaudeResetClears", () => {
  it("names a single limit", () => {
    expect(formatClaudeResetClears(["five_hour"])).toBe("session limits");
  });

  it("collapses the three weekly variants into one name", () => {
    expect(formatClaudeResetClears(["seven_day", "seven_day_opus"])).toBe(
      "weekly + Opus weekly limits"
    );
    expect(formatClaudeResetClears(["seven_day", "seven_day_overage_included"])).toBe("weekly limits");
  });

  it("drops unknown limit ids", () => {
    expect(formatClaudeResetClears(["five_hour", "mystery"])).toBe("session limits");
  });

  it("falls back to the bare word when nothing is known", () => {
    expect(formatClaudeResetClears([])).toBe("limits");
    expect(formatClaudeResetClears(null)).toBe("limits");
    expect(formatClaudeResetClears(["mystery"])).toBe("limits");
  });
});

describe("claudeGrantStatus", () => {
  const future = () => new Date(Date.now() + 3600_000).toISOString();
  const past = () => new Date(Date.now() - 3600_000).toISOString();

  it("reports used when no resets are left, even if also paused", () => {
    expect(claudeGrantStatus({ resetsLeft: 0 })).toBe("used");
    expect(claudeGrantStatus({ resetsLeft: 0, paused: true })).toBe("used");
  });

  it("reports paused after checking resets", () => {
    expect(claudeGrantStatus({ resetsLeft: 3, paused: true })).toBe("paused");
  });

  it("reports expired before usable-now", () => {
    expect(claudeGrantStatus({ resetsLeft: 3, endsAt: past(), usableNow: true })).toBe("expired");
  });

  it("reports usable now", () => {
    expect(claudeGrantStatus({ resetsLeft: 3, endsAt: future(), usableNow: true })).toBe("usable now");
  });

  it("reports not started for a future start", () => {
    expect(claudeGrantStatus({ resetsLeft: 3, startsAt: future() })).toBe("not started");
  });

  it("reports at limit only when a limit is required", () => {
    expect(claudeGrantStatus({ resetsLeft: 3, useRequiresLimit: true })).toBe("at limit only");
  });

  it("reports unavailable as the last resort", () => {
    expect(claudeGrantStatus({ resetsLeft: 3 })).toBe("unavailable");
  });
});

describe("providerLabel", () => {
  const catalog = { openai: { name: "OpenAI" } };

  it("prefers the per-connection node name", () => {
    expect(
      providerLabel("openai", { providerSpecificData: { nodeName: "My Node" } }, catalog)
    ).toBe("My Node");
  });

  it("falls back to the catalog name", () => {
    expect(providerLabel("openai", undefined, catalog)).toBe("OpenAI");
  });

  it("falls back to the id when the provider is unknown", () => {
    expect(providerLabel("mystery", undefined, catalog)).toBe("mystery");
    expect(providerLabel("mystery")).toBe("mystery");
  });
});

describe("formatCreditDate", () => {
  it("renders a human date", () => {
    expect(formatCreditDate("2026-03-15T10:30:00.000Z")).toMatch(/Mar/);
    expect(formatCreditDate("2026-03-15T10:30:00.000Z")).toMatch(/2026/);
  });

  it("returns N/A for missing or invalid values", () => {
    expect(formatCreditDate(null)).toBe("N/A");
    expect(formatCreditDate(undefined)).toBe("N/A");
    expect(formatCreditDate("")).toBe("N/A");
    expect(formatCreditDate("not-a-date")).toBe("N/A");
  });
});

describe("formatTimeRemaining", () => {
  const now = Date.parse("2026-03-15T10:00:00.000Z");

  it("renders days and hours", () => {
    expect(formatTimeRemaining("2026-03-17T13:00:00.000Z", now)).toBe("2d 3h");
  });

  it("renders hours only under a day", () => {
    expect(formatTimeRemaining("2026-03-15T15:00:00.000Z", now)).toBe("5h");
  });

  it("rounds up, so half an hour left reads as an hour rather than zero", () => {
    expect(formatTimeRemaining("2026-03-15T10:30:00.000Z", now)).toBe("1h");
    expect(formatTimeRemaining("2026-03-15T10:00:30.000Z", now)).toBe("1h");
  });

  it("reports Expired at or past the deadline", () => {
    expect(formatTimeRemaining("2026-03-15T10:00:00.000Z", now)).toBe("Expired");
    expect(formatTimeRemaining("2026-03-14T10:00:00.000Z", now)).toBe("Expired");
  });

  it("returns N/A for missing or invalid values", () => {
    expect(formatTimeRemaining(null, now)).toBe("N/A");
    expect(formatTimeRemaining("", now)).toBe("N/A");
    expect(formatTimeRemaining("not-a-date", now)).toBe("N/A");
  });
});
