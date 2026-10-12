import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os
vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

// Mock fs/promises
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// Shared mock db instance
const mockDbInstance = {
  prepare: vi.fn(),
  close: vi.fn(),
  __throwOnConstruct: false,
};

// Mock better-sqlite3 as a class so `new Database(...)` works
vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    constructor() {
      if (mockDbInstance.__throwOnConstruct) {
        throw new Error("SQLITE_CANTOPEN");
      }
      return mockDbInstance;
    }
  },
}));

// We need to dynamically import after mocks are registered
let GET;

/**
 * Row map the mocked better-sqlite3 answers with. The route looks up one key
 * at a time via .get(), so the mock resolves by the bound key rather than
 * returning a fixed list.
 */
const stubRows = (rows) => {
  mockDbInstance.prepare.mockImplementation(() => ({
    get: vi.fn((key) => rows[key] || null),
  }));
};

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbInstance.__throwOnConstruct = false;
    // Force darwin so macOS-specific logic is exercised
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    // Re-import to pick up fresh mocks each run
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  // ── macOS path probing ────────────────────────────────────────────────

  it("returns not-found listing the probed locations when no db is accessible", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
    expect(response.body.error).toContain("state.vscdb");
    expect(response.body.error).toContain("globalStorage");
  });

  it("falls back to manual mode when the db exists but cannot be opened", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__throwOnConstruct = true;

    const response = await GET();

    // better-sqlite3 and the sqlite3 CLI both fail, so the route asks the user
    // to paste credentials instead of reporting a silent success.
    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
    expect(response.body.dbPath).toContain("state.vscdb");
  });

  // ── Token extraction ──────────────────────────────────────────────────

  it("extracts tokens using exact keys", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubRows({
      "cursorAuth/accessToken": { value: "test-token" },
      "storage.serviceMachineId": { value: "test-machine-id" },
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");
    expect(mockDbInstance.close).toHaveBeenCalled();
  });

  it("unwraps JSON-encoded string values", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubRows({
      "cursorAuth/accessToken": { value: '"json-token"' },
      "storage.serviceMachineId": { value: '"json-machine-id"' },
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
  });

  it("falls back to the alternate key aliases", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubRows({
      "cursorAuth/token": { value: "alias-token" },
      "storage.machineId": { value: "alias-machine" },
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("alias-token");
    expect(response.body.machineId).toBe("alias-machine");
  });

  it("returns manual-mode fallback when no tokens are found", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubRows({});

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
  });

  // ── Platform-specific paths ───────────────────────────────────────────

  it("linux probes the .config paths and lists them when absent", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain(".config/Cursor/User/globalStorage/state.vscdb");
  });

  it("linux skips auto-import when config exists but Cursor is not installed", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    // db file is readable, but neither `which cursor` nor the .desktop file exists
    vi.mocked(fsPromises.access).mockImplementation(async (target) => {
      if (String(target).includes("state.vscdb")) return undefined;
      throw new Error("ENOENT");
    });
    stubRows({
      "cursorAuth/accessToken": { value: "test-token" },
      "storage.serviceMachineId": { value: "test-machine-id" },
    });

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("does not appear to be installed");
  });

  it("windows probes APPDATA and LOCALAPPDATA locations", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    // Windows candidates live under AppData\Roaming / AppData\Local.
    expect(response.body.error).toContain("AppData");
    expect(response.body.error).toContain("globalStorage");
  });

  it("an unknown platform falls through to the POSIX paths rather than erroring", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    // The route has no unsupported-platform branch: it reports the POSIX paths
    // it probed instead of a 400.
    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("state.vscdb");
  });
});