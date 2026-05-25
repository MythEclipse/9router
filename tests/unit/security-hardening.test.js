import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

function makeRequest({ host = "localhost:20128", origin, token, cookie, pathname = "/api/tunnel/tailscale-install" } = {}) {
  const headers = new Headers({ host });
  if (origin) headers.set("origin", origin);
  if (token) headers.set("x-9r-cli-token", token);
  const cookies = { get: () => cookie ? { value: cookie } : undefined };
  return { headers, cookies, nextUrl: { pathname } };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-security-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
});

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  vi.resetModules();
});

describe("security hardening", () => {
  it("server CLI token includes the shared CLI secret", async () => {
    const { getConsistentMachineId } = await import("../../src/shared/utils/machineId.js");
    const { __test__ } = await import("../../src/dashboardGuard.js");

    const token = await getConsistentMachineId("9r-cli-auth");
    expect(await __test__.hasValidCliToken(makeRequest({ token }))).toBe(true);
    expect(token).not.toBe("");
  });

  it("local-only routes reject spoofed loopback Host from non-local addresses", async () => {
    const { __test__ } = await import("../../src/dashboardGuard.js");

    const request = makeRequest({
      host: "localhost:20128",
      origin: "http://localhost:20128",
    });
    request.ip = "203.0.113.10";

    expect(__test__.isLocalRequest(request)).toBe(false);
  });

  it("all API files using child_process are covered by local-only guard", async () => {
    const guard = fs.readFileSync(path.join(process.cwd(), "src/dashboardGuard.js"), "utf8");
    const localOnly = [...guard.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]);
    const apiDir = path.join(process.cwd(), "src/app/api");
    const offenders =[];

    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) {
          const source = fs.readFileSync(full, "utf8");
          if (!/child_process|exec\(|execSync\(|spawn\(/.test(source)) return;
          const rel = path.relative(apiDir, full).replace(/\/route\.js$/, "");
          const route = `/api/${rel}`.replace(/\\/g, "/");
          if (!localOnly.some((p) => route.startsWith(p))) offenders.push(route);
        }
      }
    }

    walk(apiDir);
    expect(offenders).toEqual([]);
  });

  it("Claude settings env rejects unsupported keys", async () => {
    const mod = await import("../../src/app/api/cli-tools/claude-settings/route.js");
    expect(mod.__test__.sanitizeClaudeEnv({ ANTHROPIC_AUTH_TOKEN: "x", NODE_OPTIONS: "--inspect" })).toEqual({
      ANTHROPIC_AUTH_TOKEN: "x",
    });
  });

  it("changelog markdown sanitizer strips executable HTML", async () => {
    const mod = await import("../../src/shared/utils/sanitizeHtml.js");
    expect(mod.sanitizeHtml('<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>')).toBe('<img><a>x</a>');
  });

  it("login limiter ignores untrusted x-forwarded-for", async () => {
    const { getClientIp } = await import("../../src/lib/auth/loginLimiter.js");
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.7",
      "x-real-ip": "203.0.113.9",
    });
    const request = { headers, ip: "192.0.2.3" };

    expect(getClientIp(request)).toBe("192.0.2.3");
  });
});
