import { describe, it, expect } from "vitest";
import {
  formatTokenCount,
  formatTokenCountPrecise,
  formatCostScaled,
  formatCostCents,
  formatCostPrecise,
  formatCount,
  formatRawCount,
  formatBytes,
  formatByteSize,
} from "@/shared/utils/chartFormat";

/**
 * These replace four `fmtTokens` and four `fmtCost` copies that disagreed on
 * precision. The variants are kept distinct, and each is checked against the exact
 * expression it replaced so unifying them later is a visible decision.
 */
describe("formatTokenCount", () => {
  // Was inlined identically in ProviderBarChart, TopModelsChart and UsageChart.
  const legacy = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n || 0);
  };

  it("matches the expression it replaced across the range", () => {
    const values = [0, 1, 999, 1000, 1500, 250000, 999999, 1000000, 1234567, 2500000000];
    for (const v of values) {
      expect(formatTokenCount(v)).toBe(legacy(v));
    }
  });

  it("uses one decimal at both scales", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
    expect(formatTokenCount(1000)).toBe("1.0K");
    expect(formatTokenCount(850_000)).toBe("850.0K");
  });

  it("shows small counts as-is", () => {
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(0)).toBe("0");
  });

  it("treats null, undefined and NaN as zero", () => {
    expect(formatTokenCount(null)).toBe("0");
    expect(formatTokenCount(undefined)).toBe("0");
    expect(formatTokenCount(NaN)).toBe("0");
  });
});

describe("formatTokenCountPrecise", () => {
  // Pxpipe's own variant: two decimals on millions. Kept separate on purpose.
  it("uses two decimals on millions and one on thousands", () => {
    expect(formatTokenCountPrecise(1_234_567)).toBe("1.23M");
    expect(formatTokenCountPrecise(1500)).toBe("1.5K");
  });

  it("differs from the standard variant, which is why it exists", () => {
    expect(formatTokenCountPrecise(1_234_567)).not.toBe(formatTokenCount(1_234_567));
  });
});

describe("formatCostScaled", () => {
  // Was inlined in ProviderBarChart: precision proportional to magnitude.
  const legacy = (n: number) => {
    if (!n) return "$0";
    if (n >= 100) return `$${n.toFixed(0)}`;
    if (n >= 1) return `$${n.toFixed(2)}`;
    return `$${n.toFixed(4)}`;
  };

  it("matches the expression it replaced", () => {
    for (const v of [0, 0.00001, 0.0042, 0.5, 1, 1.005, 12.345, 99.99, 100, 1234.5]) {
      expect(formatCostScaled(v)).toBe(legacy(v));
    }
  });

  it("renders a zero cost without decimals", () => {
    expect(formatCostScaled(0)).toBe("$0");
    expect(formatCostScaled(null)).toBe("$0");
  });

  it("keeps four decimals below a dollar so a fraction of a cent is not lost", () => {
    expect(formatCostScaled(0.0042)).toBe("$0.0042");
  });

  it("drops to whole dollars above a hundred", () => {
    expect(formatCostScaled(1234.5)).toBe("$1235");
  });
});

describe("formatCostCents", () => {
  it("matches the OverviewCards and UsageTable expression", () => {
    const legacy = (n?: number) => `$${(n || 0).toFixed(2)}`;
    for (const v of [0, 0.005, 1.239, 99.999, 1000]) {
      expect(formatCostCents(v)).toBe(legacy(v));
    }
  });

  it("always shows two decimals", () => {
    expect(formatCostCents(0)).toBe("$0.00");
    expect(formatCostCents(12)).toBe("$12.00");
  });

  it("treats null and undefined as zero", () => {
    expect(formatCostCents(null)).toBe("$0.00");
    expect(formatCostCents(undefined)).toBe("$0.00");
  });
});

describe("formatCostPrecise", () => {
  it("matches the UsageChart expression", () => {
    const legacy = (n: number) => `$${(n || 0).toFixed(4)}`;
    for (const v of [0, 0.00001, 0.5, 1234.5]) {
      expect(formatCostPrecise(v)).toBe(legacy(v));
    }
  });

  it("keeps four decimals even for large totals", () => {
    expect(formatCostPrecise(2)).toBe("$2.0000");
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(1234567)).toBe(new Intl.NumberFormat().format(1234567));
    expect(formatCount(1000)).toBe("1,000");
  });

  it("treats null and undefined as zero", () => {
    expect(formatCount(null)).toBe("0");
    expect(formatCount(undefined)).toBe("0");
  });
});

describe("formatRawCount", () => {
  it("does not group", () => {
    expect(formatRawCount(1234567)).toBe("1234567");
  });

  it("treats null and undefined as zero", () => {
    expect(formatRawCount(null)).toBe("0");
    expect(formatRawCount(undefined)).toBe("0");
  });
});

describe("formatBytes", () => {
  // Was inlined in RequestDetailsTab: capped at MB.
  const legacy = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  it("matches the expression it replaced", () => {
    for (const v of [0, 1, 512, 1023, 1024, 1536, 1048576, 5 * 1073741824]) {
      expect(formatBytes(v)).toBe(legacy(v));
    }
  });

  it("keeps the one-decimal form and the MB cap", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5 * 1073741824)).toBe("5120.0 MB");
  });
});

describe("formatByteSize", () => {
  // Was inlined in DownloadBackupModal: scales to GB and drops trailing zeros.
  const legacy = (bytes: number) => {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  it("matches the expression it replaced", () => {
    for (const v of [0, 1, 512, 1024, 1536, 1048576, 5 * 1073741824, 999]) {
      expect(formatByteSize(v)).toBe(legacy(v));
    }
  });

  it("scales past MB, unlike formatBytes", () => {
    expect(formatByteSize(5 * 1073741824)).toBe("5 GB");
    expect(formatBytes(5 * 1073741824)).toBe("5120.0 MB");
  });

  it("drops a trailing zero decimal", () => {
    expect(formatByteSize(1024)).toBe("1 KB");
    expect(formatByteSize(1536)).toBe("1.5 KB");
  });

  it("renders zero as 0 B", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(null)).toBe("0 B");
  });
});
