import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

describe("proxyFetch MITM bypass connector", () => {
  it("passes default options when creating undici connector", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "open-sse/utils/proxyFetch.js"), "utf8");

    expect(source).toContain("buildConnector({})");
    expect(source).not.toContain("buildConnector()");
  });
});
