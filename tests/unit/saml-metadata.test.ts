import { describe, it, expect } from "vitest";
import {
  hasXmlParseError,
  readSamlMetadata,
  describeSamlImport,
} from "@/app/(dashboard)/dashboard/profile/samlMetadata";

/**
 * The test environment is `node`, so there is no DOMParser. These fakes stand in for
 * the two Document methods the module uses (querySelector and querySelectorAll) and
 * nothing else — enough to pin the selection rules, which is where the bugs live.
 * Namespace handling itself is the browser's job, not this module's.
 */
interface FakeNode {
  attrs?: Record<string, string>;
  /** Mirrors the DOM: `textContent` is the property, not `text`. */
  textContent?: string;
}

function fakeDoc(opts: {
  entityID?: string | null;
  sso?: FakeNode[];
  cert?: FakeNode | null;
  parseError?: boolean;
}): Document {
  return {
    documentElement: { getAttribute: (name: string) => (name === "entityID" ? opts.entityID ?? null : null) },
    querySelector: (selector: string) => {
      if (selector === "parsererror") return opts.parseError ? {} : null;
      if (selector.includes("X509Certificate")) return opts.cert ?? null;
      return null;
    },
    querySelectorAll: (selector: string) => (selector.includes("SingleSignOnService") ? (opts.sso ?? []) : []),
  } as unknown as Document;
}

function ssoNode(attrs: Record<string, string>): FakeNode & { getAttribute: (n: string) => string | null } {
  return {
    attrs,
    getAttribute: (name: string) => attrs[name] ?? null,
  } as unknown as FakeNode & { getAttribute: (n: string) => string | null };
}

describe("hasXmlParseError", () => {
  it("detects the parsererror element DOMParser returns instead of throwing", () => {
    expect(hasXmlParseError(fakeDoc({ parseError: true }))).toBe(true);
    expect(hasXmlParseError(fakeDoc({}))).toBe(false);
  });
});

describe("readSamlMetadata", () => {
  it("reads the entityID from the document element", () => {
    expect(readSamlMetadata(fakeDoc({ entityID: "urn:acme:idp" })).entityId).toBe("urn:acme:idp");
  });

  it("treats a missing entityID as empty rather than null", () => {
    expect(readSamlMetadata(fakeDoc({ entityID: null })).entityId).toBe("");
  });

  it("prefers the HTTP-Redirect SSO endpoint", () => {
    // A browser navigation uses the redirect binding, so that is the one that must work.
    const doc = fakeDoc({
      sso: [
        ssoNode({ Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST", Location: "https://idp/post" }),
        ssoNode({ Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect", Location: "https://idp/redirect" }),
      ],
    });
    expect(readSamlMetadata(doc).entryPoint).toBe("https://idp/redirect");
  });

  it("keeps the last located endpoint when no redirect binding exists", () => {
    const doc = fakeDoc({
      sso: [
        ssoNode({ Binding: "HTTP-POST", Location: "https://idp/first" }),
        ssoNode({ Binding: "HTTP-POST", Location: "https://idp/last" }),
      ],
    });
    expect(readSamlMetadata(doc).entryPoint).toBe("https://idp/last");
  });

  it("skips an endpoint with no Location", () => {
    const doc = fakeDoc({
      sso: [ssoNode({ Binding: "HTTP-POST", Location: "" }), ssoNode({ Binding: "HTTP-POST", Location: "https://idp/ok" })],
    });
    expect(readSamlMetadata(doc).entryPoint).toBe("https://idp/ok");
  });

  it("reads and trims the certificate", () => {
    const doc = fakeDoc({ cert: { textContent: "\n  MIIB...cert...\n  " } });
    expect(readSamlMetadata(doc).certificate).toBe("MIIB...cert...");
  });

  it("treats a missing certificate as empty", () => {
    expect(readSamlMetadata(fakeDoc({ cert: null })).certificate).toBe("");
  });

  it("returns empty fields for metadata with nothing in it", () => {
    expect(readSamlMetadata(fakeDoc({}))).toEqual({ entryPoint: "", entityId: "", certificate: "" });
  });
});

describe("describeSamlImport", () => {
  it("reports each field so a partial import is visible", () => {
    const msg = describeSamlImport({ entryPoint: "https://idp", entityId: "", certificate: "" });
    expect(msg).toContain("SSO URL: found");
    expect(msg).toContain("EntityID: not found");
    expect(msg).toContain("Cert: not found");
  });

  it("reports all three when all are present", () => {
    const msg = describeSamlImport({ entryPoint: "https://idp", entityId: "urn:x", certificate: "CERT" });
    expect(msg.match(/found/g)?.length).toBe(3);
    expect(msg).not.toContain("not found");
  });

  it("reports nothing found for an empty metadata document", () => {
    expect(describeSamlImport({ entryPoint: "", entityId: "", certificate: "" })).toContain(
      "SSO URL: not found, EntityID: not found, Cert: not found"
    );
  });

  it("matches the string it replaced", () => {
    const legacy = (ssoUrl: string, entityID: string, certStr: string) =>
      `IdP Metadata imported! (SSO URL: ${ssoUrl ? "found" : "not found"}, EntityID: ${entityID ? "found" : "not found"}, Cert: ${certStr ? "found" : "not found"})`;
    const cases: [string, string, string][] = [
      ["https://idp", "urn:x", "CERT"],
      ["", "", ""],
      ["https://idp", "", "CERT"],
      ["", "urn:x", ""],
    ];
    for (const [a, b, c] of cases) {
      expect(describeSamlImport({ entryPoint: a, entityId: b, certificate: c })).toBe(legacy(a, b, c));
    }
  });
});
