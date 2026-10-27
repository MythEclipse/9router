"use client";

/**
 * Every piece of state and every request the SSO card owns.
 *
 * Single sign-on has two protocols that share one setting (`authMode`), one credential
 * store, and one "test connection" affordance, so splitting the hook per protocol
 * would leave both halves reaching for the other's mode. This owns the whole slice and
 * the card becomes a description of what it renders.
 *
 * `settings` is passed in rather than fetched: it belongs to the page, and the two
 * save paths merge the response back into it so the rest of the profile sees the new
 * mode without a reload.
 */
import { useState, useRef, useCallback } from "react";
import {
  isOidcSaveAllowed,
  buildOidcPayload,
  oidcFormFromResponse,
  oidcSaveMessage,
  canTestOidc,
  oidcTestSuccessMessage,
} from "./profileHelpers";
import { hasXmlParseError, readSamlMetadata, describeSamlImport } from "./samlMetadata";

export interface SsoForm {
  authMode: string;
  oidcIssuerUrl: string;
  oidcClientId: string;
  oidcScopes: string;
  oidcLoginLabel: string;
}

export interface SamlForm {
  samlEntryPoint: string;
  samlIssuer: string;
  samlCert: string;
  samlLoginLabel: string;
  samlAttributeEmail: string;
  samlAttributeName: string;
}

export interface StatusMessage {
  type: "" | "success" | "error";
  message: string;
}

function emptyStatus(): StatusMessage {
  return { type: "", message: "" };
}

function samlFormFrom(settings: Record<string, unknown> | undefined): SamlForm {
  const s = settings ?? {};
  return {
    samlEntryPoint: str(s.samlEntryPoint),
    samlIssuer: str(s.samlIssuer) || "urn:9router:sp",
    samlCert: str(s.samlCert),
    samlLoginLabel: str(s.samlLoginLabel) || "Sign in with SAML SSO",
    samlAttributeEmail: str(s.samlAttributeEmail) || "email",
    samlAttributeName: str(s.samlAttributeName) || "name",
  };
}

function oidcFormFrom(settings: Record<string, unknown> | undefined): SsoForm {
  const s = settings ?? {};
  return {
    authMode: str(s.authMode),
    oidcIssuerUrl: str(s.oidcIssuerUrl),
    oidcClientId: str(s.oidcClientId),
    oidcScopes: str(s.oidcScopes),
    oidcLoginLabel: str(s.oidcLoginLabel),
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The URLs the operator has to paste into their IdP console. */
export function ssoCallbackUrls(origin: string) {
  return {
    oidcRedirectUri: origin ? `${origin}/api/auth/oidc/callback` : "/api/auth/oidc/callback",
    samlAcsUrl: origin ? `${origin}/api/auth/saml/acs` : "/api/auth/saml/acs",
    samlMetadataUrl: origin ? `${origin}/api/auth/saml/metadata` : "/api/auth/saml/metadata",
  };
}

interface UseSsoOptions {
  /** The page's settings, read for the current mode and merged after a save. */
  settings: Record<string, unknown>;
  /** Lets a save update the page's settings without a refetch. */
  onSettingsMerged: (patch: Record<string, unknown>) => void;
}

export function useSso({ settings, onSettingsMerged }: UseSsoOptions) {
  const [ssoTypeTab, setSsoTypeTab] = useState<"saml" | "oidc">("saml");
  const [oidcExpanded, setOidcExpanded] = useState(false);
  const [showSamlGuide, setShowSamlGuide] = useState(false);

  const [oidcForm, setOidcForm] = useState<SsoForm>(() => oidcFormFrom(undefined));
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcStatus, setOidcStatus] = useState<StatusMessage>(emptyStatus);
  const [oidcLoading, setOidcLoading] = useState(false);
  const [oidcTestLoading, setOidcTestLoading] = useState(false);
  const [oidcTestStatus, setOidcTestStatus] = useState<StatusMessage>(emptyStatus);

  const [samlForm, setSamlForm] = useState<SamlForm>(() => samlFormFrom(undefined));
  const [samlStatus, setSamlStatus] = useState<StatusMessage>(emptyStatus);
  const [samlLoading, setSamlLoading] = useState(false);
  const [samlTestLoading, setSamlTestLoading] = useState(false);
  const [samlTestStatus, setSamlTestStatus] = useState<StatusMessage>(emptyStatus);

  const idpMetadataFileRef = useRef<HTMLInputElement | null>(null);
  const certFileRef = useRef<HTMLInputElement | null>(null);

  // Settings arrive after the first render, so the forms start empty and the page
  // calls `hydrate` once the fetch resolves. Keeping that an explicit call rather than
  // an effect on `settings` is deliberate: an effect would also fire on every unrelated
  // settings change and overwrite whatever the operator was typing.

  /**
   * Adopt a saved settings payload.
   *
   * The page fetches settings once and hands them over, rather than having the hook
   * fetch a second copy: two readers of the same endpoint is how the card and the page
   * end up disagreeing about which mode is active.
   */
  const hydrate = useCallback((data: Record<string, unknown> | undefined) => {
    setOidcForm(oidcFormFrom(data));
    setOidcClientSecret("");
    setSamlForm(samlFormFrom(data));
    if (data?.ssoType === "saml" || data?.ssoType === "oidc") setSsoTypeTab(data.ssoType);
    if (["sso", "saml", "oidc", "both"].includes(str(data?.authMode))) setOidcExpanded(true);
  }, []);

  const updateOidcForm = (field: keyof SsoForm, value: string) => {
    setOidcForm((prev) => ({ ...prev, [field]: value }));
  };
  const updateSamlForm = (field: keyof SamlForm, value: string) => {
    setSamlForm((prev) => ({ ...prev, [field]: value }));
  };

  const saveOidcSettings = async (authMode = oidcForm.authMode || "password") => {
    const issuerUrl = oidcForm.oidcIssuerUrl.trim();
    const clientId = oidcForm.oidcClientId.trim();
    const secret = oidcClientSecret.trim();

    if (!isOidcSaveAllowed({ authMode, issuerUrl, clientId, secret, alreadyConfigured: Boolean(settings.oidcConfigured) })) {
      setOidcStatus({ type: "error", message: "Issuer URL, client ID, and client secret are required to enable OIDC." });
      return;
    }

    setOidcLoading(true);
    setOidcStatus(emptyStatus());
    setOidcTestStatus(emptyStatus());

    try {
      const payload = buildOidcPayload(oidcForm, secret, authMode);
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok) {
        onSettingsMerged(data);
        setOidcForm(oidcFormFromResponse(data, { authMode, form: oidcForm }));
        setOidcClientSecret("");
        setOidcStatus({ type: "success", message: oidcSaveMessage(authMode) });
      } else {
        setOidcStatus({ type: "error", message: data.error || "Failed to save OIDC settings" });
      }
    } catch (err) {
      console.error("[sso] failed to save OIDC settings:", err);
      setOidcStatus({ type: "error", message: "An error occurred" });
    } finally {
      setOidcLoading(false);
    }
  };

  const testOidcConnection = async () => {
    const issuerUrl = oidcForm.oidcIssuerUrl.trim();
    const clientId = oidcForm.oidcClientId.trim();
    const scopes = oidcForm.oidcScopes.trim();
    const secret = oidcClientSecret.trim();

    if (!canTestOidc(issuerUrl, clientId)) {
      setOidcTestStatus({ type: "error", message: "Issuer URL and client ID are required to test the connection." });
      return;
    }

    setOidcTestLoading(true);
    setOidcStatus(emptyStatus());
    setOidcTestStatus(emptyStatus());

    try {
      // The test reads what is stored, so unsaved fields have to be persisted first.
      const saveRes = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authMode: oidcForm.authMode || str(settings.authMode) || "password",
          oidcIssuerUrl: issuerUrl,
          oidcClientId: clientId,
          oidcScopes: scopes || "openid profile email",
          oidcLoginLabel: oidcForm.oidcLoginLabel.trim() || "Sign in with OIDC",
          ...(secret ? { oidcClientSecret: secret } : {}),
        }),
      });

      const saved = await saveRes.json().catch(() => ({}));
      if (!saveRes.ok) {
        setOidcTestStatus({ type: "error", message: saved.error || "Failed to save OIDC settings before testing" });
        return;
      }

      const res = await fetch("/api/auth/oidc/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issuerUrl: saved.oidcIssuerUrl || issuerUrl,
          clientId: saved.oidcClientId || clientId,
          scopes: saved.oidcScopes || scopes || "openid profile email",
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        setOidcTestStatus({ type: "success", message: oidcTestSuccessMessage(data) });
      } else {
        setOidcTestStatus({ type: "error", message: data.error || "OIDC connection test failed" });
      }
    } catch (err) {
      console.error("[sso] OIDC connection test failed:", err);
      setOidcTestStatus({ type: "error", message: "An error occurred" });
    } finally {
      setOidcTestLoading(false);
    }
  };

  const handleIdpMetadataUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (idpMetadataFileRef.current) idpMetadataFileRef.current.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const xmlText = String(e.target?.result || "");
        const doc = new DOMParser().parseFromString(xmlText, "text/xml");
        if (hasXmlParseError(doc)) {
          setSamlStatus({ type: "error", message: "Unable to parse valid SAML IdP metadata from XML file" });
          return;
        }

        const fields = readSamlMetadata(doc);
        setSamlForm((prev) => ({
          ...prev,
          samlEntryPoint: fields.entryPoint || prev.samlEntryPoint,
          samlIssuer: prev.samlIssuer || "urn:9router:sp",
          samlCert: fields.certificate || prev.samlCert,
        }));
        setSamlStatus({ type: "success", message: describeSamlImport(fields) });
      } catch (err) {
        console.error("[sso] failed to read IdP metadata:", err);
        setSamlStatus({ type: "error", message: "Error reading IdP Metadata XML file" });
      }
    };
    reader.readAsText(file);
  };

  const handleCertFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (certFileRef.current) certFileRef.current.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = String(e.target?.result || "");
      setSamlForm((prev) => ({ ...prev, samlCert: text.trim() }));
      setSamlStatus({ type: "success", message: "Certificate file loaded into configuration." });
    };
    reader.readAsText(file);
  };

  const saveSamlSettings = async (targetAuthMode = oidcForm.authMode || "password") => {
    setSamlLoading(true);
    setSamlStatus(emptyStatus());
    setSamlTestStatus(emptyStatus());

    try {
      const payload = {
        authMode: targetAuthMode,
        ssoType: "saml",
        samlEntryPoint: samlForm.samlEntryPoint.trim(),
        samlIssuer: samlForm.samlIssuer.trim() || "urn:9router:sp",
        samlCert: samlForm.samlCert.trim(),
        samlLoginLabel: samlForm.samlLoginLabel.trim() || "Sign in with SAML SSO",
        samlAttributeEmail: samlForm.samlAttributeEmail.trim() || "email",
        samlAttributeName: samlForm.samlAttributeName.trim() || "name",
      };

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok) {
        onSettingsMerged(data);
        setSamlForm(samlFormFrom({ ...payload, ...data }));
        setSamlStatus({
          type: "success",
          message:
            targetAuthMode === "sso" || targetAuthMode === "saml"
              ? "SAML SSO login enabled"
              : targetAuthMode === "both"
                ? "Password and SAML SSO login enabled"
                : "SAML 2.0 settings saved",
        });
      } else {
        setSamlStatus({ type: "error", message: data.error || "Failed to save SAML settings" });
      }
    } catch (err) {
      console.error("[sso] failed to save SAML settings:", err);
      setSamlStatus({ type: "error", message: "An error occurred while saving SAML settings" });
    } finally {
      setSamlLoading(false);
    }
  };

  const testSamlConnection = async () => {
    setSamlTestLoading(true);
    setSamlStatus(emptyStatus());
    setSamlTestStatus(emptyStatus());

    try {
      const res = await fetch("/api/auth/saml/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          samlEntryPoint: samlForm.samlEntryPoint.trim(),
          samlIssuer: samlForm.samlIssuer.trim(),
          samlCert: samlForm.samlCert.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSamlTestStatus({ type: "success", message: data.message || "SAML configuration verified!" });
      } else {
        setSamlTestStatus({ type: "error", message: data.error || "SAML configuration test failed" });
      }
    } catch (err) {
      console.error("[sso] SAML connection test failed:", err);
      setSamlTestStatus({ type: "error", message: "An error occurred while testing SAML configuration" });
    } finally {
      setSamlTestLoading(false);
    }
  };

  return {
    ssoTypeTab, setSsoTypeTab,
    oidcExpanded, setOidcExpanded,
    showSamlGuide, setShowSamlGuide,
    oidcForm, oidcClientSecret, setOidcClientSecret, oidcStatus, oidcLoading,
    oidcTestLoading, oidcTestStatus,
    samlForm, samlStatus, samlLoading, samlTestLoading, samlTestStatus, setSamlStatus,
    idpMetadataFileRef, certFileRef,
    hydrate,
    updateOidcForm, updateSamlForm,
    saveOidcSettings, testOidcConnection,
    handleIdpMetadataUpload, handleCertFileUpload, saveSamlSettings, testSamlConnection,
  };
}

/** The shape `useSso` returns, for the card's props. */
export type SsoController = ReturnType<typeof useSso>;
