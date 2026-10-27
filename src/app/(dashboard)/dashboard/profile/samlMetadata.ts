/**
 * Reading an IdP's SAML metadata XML into the fields the form expects.
 *
 * The metadata is a file the operator downloads from their identity provider, so the
 * shapes vary: Okta, Entra, and Keycloak all emit `SingleSignOnService` with different
 * bindings, and the certificate can sit anywhere under `KeyDescriptor`. This module is
 * DOM-only — it takes a parsed document and returns the three fields, so the rules can
 * be tested without a browser.
 */

export interface SamlMetadataFields {
  /** The IdP's SSO endpoint, preferring the HTTP-Redirect binding. */
  entryPoint: string;
  /** The IdP's entityID, which the SP must echo as its audience. */
  entityId: string;
  /** The IdP signing certificate, with the PEM armour already stripped. */
  certificate: string;
}

/**
 * Whether a parsed document is a real XML document rather than a browser error page.
 *
 * `DOMParser` does not throw on malformed XML — it returns a document containing a
 * `<parsererror>` element, so every caller has to check. Getting this wrong means
 * silently importing an error page as "no fields found".
 */
export function hasXmlParseError(doc: Document): boolean {
  return doc.querySelector("parsererror") !== null;
}

/**
 * Pull the SSO URL, entityID and signing certificate out of a metadata document.
 *
 * The `, *|Name` selectors match the element in any namespace, because IdP metadata is
 * routinely namespaced (`md:SingleSignOnService`) and `querySelector` without the
 * wildcard matches only the unstyled tag. When several SSO endpoints exist the
 * HTTP-Redirect one wins — that is what a browser navigation uses, so it is the one
 * that must work — and otherwise the last located endpoint is kept.
 */
export function readSamlMetadata(doc: Document): SamlMetadataFields {
  const entityId = doc.documentElement.getAttribute("entityID") || "";

  let entryPoint = "";
  for (const node of Array.from(doc.querySelectorAll("SingleSignOnService, *|SingleSignOnService"))) {
    const binding = node.getAttribute("Binding") || "";
    const location = node.getAttribute("Location") || "";
    if (!location) continue;
    entryPoint = location;
    if (binding.includes("HTTP-Redirect")) break;
  }

  const certNode = doc.querySelector("X509Certificate, *|X509Certificate");
  const certificate = (certNode?.textContent || "").trim();

  return { entryPoint, entityId, certificate };
}

/**
 * A one-line summary of what the import found.
 *
 * Reports each field separately because a partial import is the common outcome (an IdP
 * that publishes a URL but not a certificate), and "imported" alone would hide it.
 */
export function describeSamlImport(fields: SamlMetadataFields): string {
  const found = (present: boolean) => (present ? "found" : "not found");
  return (
    `IdP Metadata imported! (SSO URL: ${found(Boolean(fields.entryPoint))}, ` +
    `EntityID: ${found(Boolean(fields.entityId))}, ` +
    `Cert: ${found(Boolean(fields.certificate))})`
  );
}
