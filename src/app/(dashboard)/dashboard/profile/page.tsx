"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, Button, Toggle, Input, Select, DownloadBackupModal, downloadBackupModalKey } from "@/shared/components";
import Modal, { ConfirmModal } from "@/shared/components/Modal";
import LanguageSwitcher from "@/shared/components/LanguageSwitcher";
import SettingsHistory from "@/shared/components/SettingsHistory";
import { cn } from "@/shared/utils/cn";
import { useSessionStore } from "@/store/sessionStore";
import { useTaskStore } from "@/store/taskStore";
import { APP_CONFIG } from "@/shared/constants/config";
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";
import { LOCALE_FLAGS } from "@/shared/constants/locales";
import { getLocaleFromCookie, formatCountdown, isOidcSaveAllowed, buildOidcPayload, oidcFormFromResponse, oidcSaveMessage, canTestOidc, oidcTestSuccessMessage } from "./profileHelpers";
import SsoCard from "./SsoCard";
import { useSso } from "./useSso";

function readLocaleFromCookie() {
  return getLocaleFromCookie(
    typeof document === "undefined" ? undefined : document.cookie,
    LOCALE_COOKIE,
    normalizeLocale
  );
}

// Live countdown to the next automatic backup. The ticking state stays inside
// this component so a passing second never re-renders the whole page, and the
// parent is asked for a fresh schedule once the shown deadline passes.
function BackupCountdown({ target, onExpire, showDate = false }) {
  const [remaining, setRemaining] = useState(() => (target ? target - Date.now() : 0));
  const onExpireRef = useRef(onExpire);
  const firedRef = useRef(false);

  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    if (!target) return undefined;
    firedRef.current = false;
    // First reading happens on the tick below rather than synchronously here, so
    // the commit itself does not set state; the countdown is already keyed to
    // `target`, which is what re-arms this effect.
    const id = setInterval(() => {
      const left = target - Date.now();
      setRemaining(left);
      if (left <= 0 && !firedRef.current) {
        firedRef.current = true;
        onExpireRef.current?.();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [target]);

  if (!target) return null;
  return (
    <p className="text-xs text-text-muted">
      {`Next backup in ${formatCountdown(remaining)}`}
      {showDate && ` \u2022 at ${new Date(target).toLocaleString()}`}
    </p>
  );
}

// Background import-job endpoint built by agent B. POST starts a job from the
// same JSON body as the direct import and answers { jobId }; GET
// <endpoint>/<jobId> answers { status, progress, section, error }. A 404/405
// means the endpoint does not exist yet and the caller falls back to POST /api/settings/database.
const IMPORT_JOB_ENDPOINT = "/api/settings/database/jobs";

/** Settings fields the profile page reads (a subset of the full settings row). */
interface ProfileSettings {
  fallbackStrategy: string;
  comboStrategy?: string;
  stickyRoundRobinLimit?: number;
  comboStickyRoundRobinLimit?: number;
  authMode?: string;
  ssoType?: string;
  hasPassword?: boolean;
  requireLogin?: boolean;
  oidcConfigured?: boolean;
  outboundProxyEnabled?: boolean;
  enableObservability?: boolean;
  observabilityIncludePayloads?: boolean;
  [key: string]: unknown;
}

/** Snapshot of the saved Telegram/GitHub backup config. */
interface TelegramSavedRef {
  enabled: boolean;
  channel: string;
  intervalHours: number;
  tgChatId?: string;
  ghRepo?: string;
  tgBotToken?: string;
  ghToken?: string;
  [key: string]: unknown;
}

/** Editable OIDC form state. */
interface OidcFormState {
  authMode: string;
  oidcIssuerUrl: string;
  oidcClientId: string;
  oidcScopes: string;
  oidcLoginLabel: string;
}

/** Payload sent to PATCH /api/settings when saving OIDC config. */
interface OidcSavePayload {
  authMode: string;
  ssoType: string;
  oidcIssuerUrl: string;
  oidcClientId: string;
  oidcScopes: string;
  oidcLoginLabel: string;
  oidcClientSecret?: string;
}

export default function ProfilePage() {
  const router = useRouter();
  const [locale, setLocale] = useState(() => readLocaleFromCookie());
  const [langOpen, setLangOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const sessionRole = useSessionStore((state) => state.role);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [settings, setSettings] = useState<ProfileSettings>({ fallbackStrategy: "fill-first" });
  // SSO owns its own form state and requests; the page only supplies the saved
  // settings and takes the merged result back so the rest of the page sees the mode.
  const sso = useSso({
    settings,
    onSettingsMerged: (patch) => setSettings((prev) => ({ ...prev, ...patch })),
  });
  const { hydrate: hydrateSso } = sso;
  const [loading, setLoading] = useState(true);
  const [passwords, setPasswords] = useState({ current: "", new: "", confirm: "" });
  const [passStatus, setPassStatus] = useState({ type: "", message: "" });
  const [passLoading, setPassLoading] = useState(false);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbStatus, setDbStatus] = useState({ type: "", message: "" });
  const [dbAuth, setDbAuth] = useState({ open: false, mode: "", password: "" });
  const [showDownloadBackupModal, setShowDownloadBackupModal] = useState(false);
  const pendingImportRef = useRef(null);
  const [tgModalOpen, setTgModalOpen] = useState(false);
  const [tgForm, setTgForm] = useState({ enabled: false, channel: "telegram", interval: "24", customHours: "", tgBotToken: "", tgChatId: "", ghToken: "", ghRepo: "" });
  const [tgHasTgToken, setTgHasTgToken] = useState(false);
  const [tgHasGhToken, setTgHasGhToken] = useState(false);
  const [tgLoading, setTgLoading] = useState(false);
  const [tgStatus, setTgStatus] = useState({ type: "", message: "" });
  const [tgLastBackup, setTgLastBackup] = useState(null);
  const [tgNextRunAt, setTgNextRunAt] = useState(null);
  const tgSavedRef = useRef<TelegramSavedRef>({
    enabled: false,
    channel: "telegram",
    intervalHours: 24,
  });
  const [oidcForm, setOidcForm] = useState<OidcFormState>({
    authMode: "password",
    oidcIssuerUrl: "",
    oidcClientId: "",
    oidcScopes: "openid profile email",
    oidcLoginLabel: "Sign in with OIDC",
  });
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcStatus, setOidcStatus] = useState({ type: "", message: "" });
  const [oidcLoading, setOidcLoading] = useState(false);
  const [oidcTestLoading, setOidcTestLoading] = useState(false);
  const [oidcTestStatus, setOidcTestStatus] = useState({ type: "", message: "" });


  const origin = typeof window !== "undefined" ? window.location.origin : "";
  
  // SAML State

  const importFileRef = useRef(null);
  // Progress state for backup export/import and test runs. `busy` holds
  // { title, message, section, progress }. It has no overlay of its own: the
  // task store below is the only surface it reaches, so the run is announced in
  // the notification bell instead of taking over the page with a fixed scrim
  // anchored bottom-right.
  const [busy, setBusy] = useState(null);
  const profileTaskRef = useRef(null);

  // Report the backup run into the bell task store (no page overlay).
  useEffect(() => {
    if (busy) {
      const taskId = "profile-backup-task";
      profileTaskRef.current = taskId;
      const pct = typeof busy.progress === "number" && Number.isFinite(busy.progress)
        ? Math.min(100, Math.max(0, Math.round(busy.progress <= 1 ? busy.progress * 100 : busy.progress)))
        : 0;
      const taskData = {
        id: taskId,
        title: busy.title || "Backup Operation",
        message: busy.message || "Working",
        progress: pct,
        href: "/dashboard/profile",
      };
      const existing = useTaskStore.getState().tasks.find((t) => t.id === taskId);
      if (!existing || existing.state === "done") {
        useTaskStore.getState().start(taskData);
      } else {
        useTaskStore.getState().update(taskId, {
          title: taskData.title,
          message: taskData.message,
          progress: taskData.progress,
        });
      }
    } else if (profileTaskRef.current) {
      useTaskStore.getState().finish(profileTaskRef.current);
      profileTaskRef.current = null;
    }
  }, [busy]);

  useEffect(() => {
    return () => {
      if (profileTaskRef.current) {
        useTaskStore.getState().finish(profileTaskRef.current);
      }
    };
  }, []);
  const [proxyForm, setProxyForm] = useState({
    outboundProxyEnabled: false,
    outboundProxyUrl: "",
    outboundNoProxy: "",
  });
  const [proxyStatus, setProxyStatus] = useState({ type: "", message: "" });
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyTestLoading, setProxyTestLoading] = useState(false);

  useEffect(() => {
  loadAutoBackup();
   
  }, []);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setSettings(data);
        hydrateSso(data);
        setProxyForm({
          outboundProxyEnabled: data?.outboundProxyEnabled === true,
          outboundProxyUrl: data?.outboundProxyUrl || "",
          outboundNoProxy: data?.outboundNoProxy || "",
        });
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch settings:", err);
        setLoading(false);
      });
    // `hydrateSso` is stable (useCallback), so this still runs once on mount.
  }, [hydrateSso]);

  const updateOutboundProxy = async (e) => {
    e.preventDefault();
    if (settings.outboundProxyEnabled !== true) return;
    setProxyLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outboundProxyUrl: proxyForm.outboundProxyUrl,
          outboundNoProxy: proxyForm.outboundNoProxy,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setProxyStatus({ type: "success", message: "Proxy settings applied" });
      } else {
        setProxyStatus({ type: "error", message: data.error || "Failed to update proxy settings" });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyLoading(false);
    }
  };

  const testOutboundProxy = async () => {
    if (settings.outboundProxyEnabled !== true) return;

    const proxyUrl = (proxyForm.outboundProxyUrl || "").trim();
    if (!proxyUrl) {
      setProxyStatus({ type: "error", message: "Please enter a Proxy URL to test" });
      return;
    }

    setProxyTestLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings/proxy-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUrl }),
      });

      const data = await res.json();
      if (res.ok && data?.ok) {
        setProxyStatus({
          type: "success",
          message: `Proxy test OK (${data.status}) in ${data.elapsedMs}ms`,
        });
      } else {
        setProxyStatus({
          type: "error",
          message: data?.error || "Proxy test failed",
        });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyTestLoading(false);
    }
  };

  const updateOutboundProxyEnabled = async (outboundProxyEnabled) => {
    setProxyLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outboundProxyEnabled }),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setProxyForm((prev) => ({ ...prev, outboundProxyEnabled: data?.outboundProxyEnabled === true }));
        setProxyStatus({
          type: "success",
          message: outboundProxyEnabled ? "Proxy enabled" : "Proxy disabled",
        });
      } else {
        setProxyStatus({ type: "error", message: data.error || "Failed to update proxy settings" });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyLoading(false);
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (passwords.new !== passwords.confirm) {
      setPassStatus({ type: "error", message: "Passwords do not match" });
      return;
    }

    setPassLoading(true);
    setPassStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwords.current,
          newPassword: passwords.new,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setPassStatus({ type: "success", message: "Password updated successfully" });
        setPasswords({ current: "", new: "", confirm: "" });
      } else {
        setPassStatus({ type: "error", message: data.error || "Failed to update password" });
      }
    } catch (err) {
      setPassStatus({ type: "error", message: "An error occurred" });
    } finally {
      setPassLoading(false);
    }
  };

  const updateFallbackStrategy = async (strategy) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fallbackStrategy: strategy }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, fallbackStrategy: strategy }));
      }
    } catch (err) {
      console.error("Failed to update settings:", err);
    }
  };

  const updateComboStrategy = async (strategy) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStrategy: strategy }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, comboStrategy: strategy }));
      }
    } catch (err) {
      console.error("Failed to update combo strategy:", err);
    }
  };

  const updateStickyLimit = async (limit) => {
    const numLimit = parseInt(limit);
    if (isNaN(numLimit) || numLimit < 1) return;

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stickyRoundRobinLimit: numLimit }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, stickyRoundRobinLimit: numLimit }));
      }
    } catch (err) {
      console.error("Failed to update sticky limit:", err);
    }
  };

  const updateComboStickyLimit = async (limit) => {
    const numLimit = parseInt(limit);
    if (isNaN(numLimit) || numLimit < 1) return;

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStickyRoundRobinLimit: numLimit }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, comboStickyRoundRobinLimit: numLimit }));
      }
    } catch (err) {
      console.error("Failed to update combo sticky limit:", err);
    }
  };

  const updateRequireLogin = async (requireLogin) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireLogin }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, requireLogin }));
      }
    } catch (err) {
      console.error("Failed to update require login:", err);
    }
  };

  const updateObservabilityEnabled = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enableObservability: enabled }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, enableObservability: enabled }));
      }
    } catch (err) {
      console.error("Failed to update enableObservability:", err);
    }
  };

  // Storing payloads and SHOWING them are separate switches: a detail row is
  // recorded with its bodies either way, but GET /api/usage/request-details
  // withholds them unless this is on. Turning it on makes the logs view able to
  // read every prompt and response that passed through the gateway.
  const updateObservabilityIncludePayloads = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observabilityIncludePayloads: enabled }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, observabilityIncludePayloads: enabled }));
      }
    } catch (err) {
      console.error("Failed to update observabilityIncludePayloads:", err);
    }
  };

  const reloadSettings = async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data);
    } catch (err) {
      console.error("Failed to reload settings:", err);
  }
  };


  const loadAutoBackup = async () => {
  try {
  const res = await fetch("/api/settings/auto-backup");
  if (!res.ok) return;
  const { config, status, nextRunAt } = await res.json();
  tgSavedRef.current = config;
  setTgHasTgToken(config.hasTgToken);
  setTgHasGhToken(config.hasGhToken);
  setTgLastBackup(status || null);
  setTgNextRunAt(nextRunAt ?? null);
  const interval = [24, 168, 720].includes(config.intervalHours) ? String(config.intervalHours) : "custom";
  setTgForm((prev) => ({
  ...prev,
  enabled: config.enabled,
  channel: config.channel,
  interval,
  customHours: interval === "custom" ? String(config.intervalHours) : "",
  tgChatId: config.tgChatId || "",
  ghRepo: config.ghRepo || "",
  }));
  } catch (err) {
  console.error("Failed to load auto-backup config:", err);
  }
  };

  const saveAutoBackup = async () => {
  setTgLoading(true);
  setTgStatus({ type: "", message: "" });
  setBusy({ title: "Saving backup configuration", message: "Saving automatic backup settings" });
  try {
  const payload: TelegramSavedRef = {
  enabled: tgForm.enabled,
  channel: tgForm.channel,
  intervalHours: Number(tgForm.interval === "custom" ? tgForm.customHours : tgForm.interval),
  tgChatId: tgForm.tgChatId.trim(),
  ghRepo: tgForm.ghRepo.trim(),
  };
  if (tgForm.tgBotToken.trim()) payload.tgBotToken = tgForm.tgBotToken.trim();
  if (tgForm.ghToken.trim()) payload.ghToken = tgForm.ghToken.trim();
  const res = await fetch("/api/settings/auto-backup", {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
  setTgStatus({ type: "error", message: data.error || "Failed to save configuration" });
  return;
  }
  tgSavedRef.current = data.config;
  setTgHasTgToken(data.config.hasTgToken);
  setTgHasGhToken(data.config.hasGhToken);
  setTgForm((prev) => ({ ...prev, tgBotToken: "", ghToken: "" }));
  setTgStatus({ type: "success", message: data.config.enabled ? "Configuration saved, backups run automatically" : "Configuration saved" });
  await loadAutoBackup();
  } catch {
  setTgStatus({ type: "error", message: "An error occurred while saving the configuration" });
  } finally {
  setTgLoading(false);
  setBusy(null);
  }
  };

  const updateTgForm = (patch) => {
  setTgForm((prev) => ({ ...prev, ...patch }));
  };

  const runTestBackup = async (password) => {
  setTgLoading(true);
  setTgStatus({ type: "", message: "" });
  setBusy({ title: "Sending test backup", message: "Uploading backup to the configured channel" });
  try {
  const res = await fetch("/api/settings/auto-backup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "test", password }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok) {
  setTgStatus({ type: "success", message: "Test backup sent via " + data.channel });
  await loadAutoBackup();
  } else {
  setTgStatus({ type: "error", message: data.error || "Failed to send test backup" });
  }
  } catch {
  setTgStatus({ type: "error", message: "An error occurred while sending the test backup" });
  } finally {
  setTgLoading(false);
  setBusy(null);
  }
  };

  const handleExportDatabase = async (password: string, selectedSections: string[] = []) => {
    setDbLoading(true);
    setDbStatus({ type: "", message: "" });
    setBusy({ title: "Preparing backup", message: "Exporting database" });
    try {
      const sectionsQuery = selectedSections && selectedSections.length > 0
        ? `?sections=${selectedSections.join(",")}`
        : "";
      const res = await fetch(`/api/settings/database${sectionsQuery}`, {
        headers: { "x-9r-password": password || "" },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to export database");
      }

      const payload = await res.json();
      const content = JSON.stringify(payload, null, 2);
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      anchor.href = url;
      anchor.download = `9router-backup-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      setDbStatus({ type: "success", message: "Database backup downloaded" });
      setShowDownloadBackupModal(false);
    } catch (err) {
      setDbStatus({ type: "error", message: err.message || "Failed to export database" });
    } finally {
      setDbLoading(false);
      setBusy(null);
    }
  };

  const handleImportDatabase = (event) => {
    const file = event.target.files?.[0];
    if (importFileRef.current) importFileRef.current.value = "";
    if (!file) return;
    pendingImportRef.current = file;
    setDbStatus({ type: "", message: "" });
    setDbAuth({ open: true, mode: "import", password: "" });
  };

  // Poll a background import job started by agent B. Resolves when the job
  // reports done/failed, rejects on timeout or job failure. Non-blocking: the
  // page stays interactive while polling, progress is mirrored to the overlay.
  //
  // Auth is the poll token issued at job creation, not the password: the import
  // replaces the settings row that stores the password hash, so re-checking the
  // password on every poll starts failing part-way through a restore that is
  // actually succeeding. The password stays as a fallback for servers that
  // predate the token.
  const pollImportJob = async (jobId, password, pollToken) => {
    const startedAt = Date.now();
    const timeoutMs = 5 * 60 * 1000;
    const pollHeaders = pollToken
      ? { "x-9r-poll-token": pollToken }
      : { "x-9r-password": password || "" };
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const res = await fetch(`${IMPORT_JOB_ENDPOINT}/${encodeURIComponent(jobId)}`, {
        headers: pollHeaders,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to check import status");
      }
      const data = await res.json().catch(() => ({}));
      const status = String(data.status || "").toLowerCase();
      if (typeof data.progress !== "undefined" || data.section || data.message) {
        setBusy({
          title: "Importing database",
          message: data.message || "Import running in the background",
          section: data.section || "",
          progress: data.progress,
        });
      }
      if (status === "done" || status === "completed" || status === "success") return;
      if (status === "failed" || status === "error") {
        throw new Error(data.error || "Failed to import database");
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("Import is taking too long, please check the result and try again");
      }
    }
  };

  // Direct (synchronous) import, used as the fallback when the background
  // job endpoint from agent B is not available yet.
  const runDirectImport = async (body) => {
    const res = await fetch("/api/settings/database", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || "Failed to import database");
    }
  };

  const runImportDatabase = async (password) => {
    const file = pendingImportRef.current;
    if (!file) return;
    setDbLoading(true);
    setDbStatus({ type: "", message: "" });
    setBusy({ title: "Importing database", message: "Reading backup file" });
    try {
      const raw = await file.text();
      const payload = JSON.parse(raw);
      const body = { ...payload, password };

      // Prefer the background job flow (agent B); fall back to the direct
      // POST when the job endpoint answers 404/405 (not built yet).
      let usedJob = false;
      try {
        const jobRes = await fetch(IMPORT_JOB_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (jobRes.status === 404 || jobRes.status === 405) {
          await runDirectImport(body);
        } else {
          const jobData = await jobRes.json().catch(() => ({}));
          if (!jobRes.ok) {
            throw new Error(jobData.error || "Failed to import database");
          }
          if (jobData && jobData.jobId) {
            usedJob = true;
            setBusy({
              title: "Importing database",
              message: "Import running in the background",
              section: jobData.section || "",
              progress: jobData.progress,
            });
            await pollImportJob(jobData.jobId, password, jobData.pollToken);
          } else {
            await runDirectImport(body);
          }
        }
      } catch (err) {
        // Network-level failure of the job endpoint (not a job failure) also
        // falls back to the direct import instead of failing the restore.
        if (!usedJob && (err instanceof TypeError)) {
          await runDirectImport(body);
        } else {
          throw err;
        }
      }

      await reloadSettings();
      setDbStatus({ type: "success", message: "Database imported successfully" });
    } catch (err) {
      setDbStatus({ type: "error", message: err.message || "Invalid backup file" });
    } finally {
      pendingImportRef.current = null;
      setDbLoading(false);
      setBusy(null);
    }
  };

  // Confirm password modal, then run export or import.
  const handleDbAuthConfirm = async () => {
    const { mode, password } = dbAuth;
    setDbAuth({ open: false, mode: "", password: "" });
    if (mode === "export") await handleExportDatabase(password);
    else if (mode === "import") await runImportDatabase(password);
  else if (mode === "tgtest") await runTestBackup(password);
  };

  const observabilityEnabled = settings.enableObservability === true;

  const handleShutdown = async () => {
    setIsShuttingDown(true);
    try {
      await fetch("/api/version/shutdown", { method: "POST" });
    } catch (e) {
      // Expected to fail as server shuts down; ignore error
    }
    setIsShuttingDown(false);
    setShutdownOpen(false);
  };

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) {
        // replace() keeps the signed-in page out of history; refresh() makes the
        // layouts re-read /api/auth/status now that the cookie is gone.
        router.replace("/login");
        router.refresh();
      }
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-0">
      <div className="flex flex-col gap-6">
        {/* Local Mode Info */}
        <Card>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 rounded-lg bg-bg border border-border gap-2">
              <div>
                <p className="font-medium text-sm sm:text-base">Database Location</p>
                <p className="text-xs sm:text-sm text-text-muted font-mono break-all">~/.9router/db/data.sqlite</p>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 w-full sm:w-auto">
                {tgForm.enabled && (
                  <div className="flex flex-col gap-0.5">
                    <BackupCountdown target={tgNextRunAt} onExpire={loadAutoBackup} />
                  </div>
                )}
                <Button
                  variant="secondary"
                  icon="cloud_sync"
                  onClick={() => { setTgModalOpen(true); loadAutoBackup(); }}
                  className="w-full sm:w-auto"
                >
                  Automatic Backup
                </Button>
              </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    variant="secondary"
                    icon="download"
                    onClick={() => setShowDownloadBackupModal(true)}
                    loading={dbLoading}
                    className="w-full sm:w-auto"
                  >
                    Download Backup
                  </Button>
                  <Button
                    variant="outline"
                    icon="upload"
                    onClick={() => importFileRef.current?.click()}
                    disabled={dbLoading}
                    className="w-full sm:w-auto"
                  >
                    Import Backup
                  </Button>
                  <input
                    ref={importFileRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={handleImportDatabase}
                  />
                </div>
                {dbStatus.message && (
                  <p className={`text-sm ${dbStatus.type === "error" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>
                    {dbStatus.message}
                  </p>
                )}
            </div>
            </div>
        </Card>


        {/* Security */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
              <span className="material-symbols-outlined text-[20px]">shield</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Security</h3>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Require login</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  Require a password for the dashboard when ON, or allow access without login when OFF.
                </p>
              </div>
              <Toggle
                checked={settings.requireLogin === true}
                onChange={() => updateRequireLogin(!settings.requireLogin)}
                disabled={loading}
              />
            </div>
            {settings.requireLogin === true && (
              <form onSubmit={handlePasswordChange} className="flex flex-col gap-4 pt-4 border-t border-border/50">
                {settings.hasPassword && (
                  <div className="flex flex-col gap-2">
                    <label className="text-xs sm:text-sm font-medium">Current Password</label>
                    <Input
                      type="password"
                      placeholder="Enter current password"
                      value={passwords.current}
                      onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
                      required
                    />
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <label className="text-xs sm:text-sm font-medium">New Password</label>
                    <Input
                      type="password"
                      placeholder="Enter new password"
                      value={passwords.new}
                      onChange={(e) => setPasswords({ ...passwords, new: e.target.value })}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-xs sm:text-sm font-medium">Confirm New Password</label>
                    <Input
                      type="password"
                      placeholder="Confirm new password"
                      value={passwords.confirm}
                      onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
                      required
                    />
                  </div>
                </div>

                {passStatus.message && (
                  <p className={`text-xs sm:text-sm ${passStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                    {passStatus.message}
                  </p>
                )}

                <div className="pt-2">
                  <Button type="submit" variant="primary" loading={passLoading} className="w-full sm:w-auto">
                    {settings.hasPassword ? "Update Password" : "Set Password"}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </Card>

        {/* Single Sign-On (SSO) */}
        <SsoCard sso={sso} settings={settings} origin={origin} settingsLoading={loading} />

        {/* Routing Preferences */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">route</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Routing Strategy</h3>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Round Robin</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  Cycle through accounts to distribute load
                </p>
              </div>
              <Toggle
                checked={settings.fallbackStrategy === "round-robin"}
                onChange={() => updateFallbackStrategy(settings.fallbackStrategy === "round-robin" ? "fill-first" : "round-robin")}
                disabled={loading}
              />
            </div>

            {/* Sticky Round Robin Limit */}
            {settings.fallbackStrategy === "round-robin" && (
              <div className="flex items-start sm:items-center justify-between gap-4 pt-2 border-t border-border/50">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm sm:text-base">Sticky Limit</p>
                  <p className="text-xs sm:text-sm text-text-muted">
                    Calls per account before switching
                  </p>
                </div>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={settings.stickyRoundRobinLimit || 3}
                  onChange={(e) => updateStickyLimit(e.target.value)}
                  disabled={loading}
                  className="w-16 sm:w-20 text-center shrink-0"
                />
              </div>
            )}

            {/* Combo Round Robin */}
            <div className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Combo Round Robin</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  Cycle through providers in combos instead of always starting with first
                </p>
              </div>
              <Toggle
                checked={settings.comboStrategy === "round-robin"}
                onChange={() => updateComboStrategy(settings.comboStrategy === "round-robin" ? "fallback" : "round-robin")}
                disabled={loading}
              />
            </div>

            {/* Combo Sticky Round Robin Limit */}
            {settings.comboStrategy === "round-robin" && (
              <div className="flex items-center justify-between pt-2 border-t border-border/50">
                <div>
                  <p className="font-medium">Combo Sticky Limit</p>
                  <p className="text-sm text-text-muted">
                    Calls per combo model before switching
                  </p>
                </div>
                <Input
                  type="number"
                  min="1"
                  max="100"
                  value={settings.comboStickyRoundRobinLimit || 1}
                  onChange={(e) => updateComboStickyLimit(e.target.value)}
                  disabled={loading}
                  className="w-20 text-center"
                />
              </div>
            )}

            <p className="text-xs text-text-muted italic pt-2 border-t border-border/50">
              {settings.fallbackStrategy === "round-robin"
                ? `Currently distributing requests across all available accounts with ${settings.stickyRoundRobinLimit || 3} calls per account.`
                : "Currently using accounts in priority order (Fill First)."}
              {settings.comboStrategy === "round-robin"
                ? ` Combos rotate after ${settings.comboStickyRoundRobinLimit || 1} call${(settings.comboStickyRoundRobinLimit || 1) === 1 ? "" : "s"} per model.`
                : " Combos always start with their first model."}
            </p>
          </div>
        </Card>

        {/* Network */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-purple-500/10 text-purple-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">wifi</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Network</h3>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Outbound Proxy</p>
                <p className="text-xs sm:text-sm text-text-muted">Enable proxy for OAuth + provider outbound requests.</p>
              </div>
              <Toggle
                checked={settings.outboundProxyEnabled === true}
                onChange={() => updateOutboundProxyEnabled(!(settings.outboundProxyEnabled === true))}
                disabled={loading || proxyLoading}
              />
            </div>

            {settings.outboundProxyEnabled === true && (
              <form onSubmit={updateOutboundProxy} className="flex flex-col gap-4 pt-2 border-t border-border/50">
                <div className="flex flex-col gap-2">
                  <label className="font-medium text-sm sm:text-base">Proxy URL</label>
                  <Input
                    placeholder="http://127.0.0.1:7897"
                    value={proxyForm.outboundProxyUrl}
                    onChange={(e) => setProxyForm((prev) => ({ ...prev, outboundProxyUrl: e.target.value }))}
                    disabled={loading || proxyLoading}
                  />
                  <p className="text-xs sm:text-sm text-text-muted">Leave empty to inherit existing env proxy (if any).</p>
                </div>

                <div className="flex flex-col gap-2 pt-2 border-t border-border/50">
                  <label className="font-medium text-sm sm:text-base">No Proxy</label>
                  <Input
                    placeholder="localhost,127.0.0.1"
                    value={proxyForm.outboundNoProxy}
                    onChange={(e) => setProxyForm((prev) => ({ ...prev, outboundNoProxy: e.target.value }))}
                    disabled={loading || proxyLoading}
                  />
                  <p className="text-xs sm:text-sm text-text-muted">Comma-separated hostnames/domains to bypass the proxy.</p>
                </div>

                <div className="pt-2 border-t border-border/50 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    loading={proxyTestLoading}
                    disabled={loading || proxyLoading}
                    onClick={testOutboundProxy}
                    className="w-full sm:w-auto"
                  >
                    Test proxy URL
                  </Button>
                  <Button type="submit" variant="primary" loading={proxyLoading} className="w-full sm:w-auto">
                    Apply
                  </Button>
                </div>
              </form>
            )}

            {proxyStatus.message && (
              <p className={`text-xs sm:text-sm ${proxyStatus.type === "error" ? "text-red-500" : "text-green-500"} pt-2 border-t border-border/50`}>
                {proxyStatus.message}
              </p>
            )}
          </div>
        </Card>

        {/* Observability Settings */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-orange-500/10 text-orange-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">monitoring</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Observability</h3>
          </div>
          <div className="flex items-start sm:items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm sm:text-base">Enable Observability</p>
              <p className="text-xs sm:text-sm text-text-muted">
                Record request details for inspection in the logs view
              </p>
            </div>
            <Toggle
              checked={observabilityEnabled}
              onChange={updateObservabilityEnabled}
              disabled={loading}
            />
          </div>
          <div className="mt-4 pt-4 border-t border-black/5 dark:border-white/5 flex items-start sm:items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm sm:text-base">Include payloads in the logs view</p>
              <p className="text-xs sm:text-sm text-text-muted">
                Off by default: request and response bodies stay stored but are withheld by the
                API. Turn on to read prompts, tool calls and provider responses in the logs view —
                this exposes the full conversation history of every request through this gateway
                to anyone who can open the dashboard.
              </p>
            </div>
            <Toggle
              checked={settings.observabilityIncludePayloads === true}
              onChange={updateObservabilityIncludePayloads}
              disabled={loading}
            />
          </div>
        </Card>

        {/* Settings history: who changed what, with revert. */}
        <SettingsHistory
          onReverted={() => {
            // Settings may have been replaced wholesale; re-read the form.
            if (typeof window !== "undefined") window.location.reload();
          }}
        />

        {/* Account actions. Shutdown is administrator-only: a key session can
            open this page by URL, so the button follows the role, not the route. */}
        <div className="flex flex-col sm:flex-row gap-2">
          {sessionRole !== "apikey" && (
            <Button
              variant="outline"
              fullWidth
              icon="power_settings_new"
              onClick={() => setShutdownOpen(true)}
              className="text-danger border-danger/30 hover:bg-danger/10 hover:border-danger/40"
            >
              Shutdown
            </Button>
          )}
          <Button
            variant="outline"
            fullWidth
            icon="logout"
            onClick={handleLogout}
          >
            Logout
          </Button>
        </div>
      </div>

      <ConfirmModal
        isOpen={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title="Close Proxy"
        message="Are you sure you want to close the proxy server?"
        confirmText="Close"
        cancelText="Cancel"
        variant="danger"
        loading={isShuttingDown}
      />

      {/* Automatic Backup modal */}
      <Modal
        isOpen={tgModalOpen}
        onClose={() => setTgModalOpen(false)}
        title="Automatic Backup"
        size="md"
        footer={
        <>
        <Button variant="ghost" onClick={() => setTgModalOpen(false)} disabled={tgLoading}>
        Close
        </Button>
        <Button variant="primary" onClick={saveAutoBackup} loading={tgLoading}>
        Save Configuration
        </Button>
        </>
        }
      >
        <div className="flex flex-col gap-4">
        <div className="flex items-start sm:items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
        <p className="font-medium text-sm sm:text-base">Send backups automatically</p>
        <p className="text-xs sm:text-sm text-text-muted">
        The backup file is identical to Download Backup and can be restored with Import Backup.
        </p>
        </div>
        <Toggle
        checked={tgForm.enabled}
        onChange={(next) => updateTgForm({ enabled: next })}
        />
        </div>
        <Select
        label="Backup via"
        value={tgForm.channel}
        onChange={(e) => updateTgForm({ channel: e.target.value })}
        options={[{ value: "telegram", label: "Telegram bot" }, { value: "github", label: "GitHub repository" }]}
        />
        {tgForm.channel === "telegram" && (
        <div className="flex flex-col gap-3">
        <Input
        label="Bot Token"
        type="password"
        value={tgForm.tgBotToken}
        onChange={(e) => updateTgForm({ tgBotToken: e.target.value })}
        placeholder={tgHasTgToken ? "Saved. Leave empty to keep" : "123456789:AA..."}
        />
        <Input
        label="Owner Chat ID"
        value={tgForm.tgChatId}
      placeholder="Numeric owner chat id, e.g. 123456789"
      inputMode="numeric"
      onChange={(e) => updateTgForm({ tgChatId: e.target.value.replace(/\D+/g, "") })}
        />
        </div>
        )}
        {tgForm.channel === "github" && (
        <div className="flex flex-col gap-3">
        <Input
        label="GitHub Token"
        type="password"
        value={tgForm.ghToken}
        onChange={(e) => updateTgForm({ ghToken: e.target.value })}
        placeholder={tgHasGhToken ? "Saved. Leave empty to keep" : "ghp_..."}
        hint="Needs repo write access. Backups are committed to 9router-backups/ in the repository below."
        />
        <Input
        label="Repository (owner/repo)"
        value={tgForm.ghRepo}
        onChange={(e) => updateTgForm({ ghRepo: e.target.value })}
        placeholder="e.g. asepharyana/9router-backups"
        />
        </div>
        )}
        <div className="flex flex-col sm:flex-row gap-3">
        <Select
        label="Interval"
        value={tgForm.interval}
        onChange={(e) => updateTgForm({ interval: e.target.value })}
        options={[{ value: "24", label: "Every 24 hours" }, { value: "168", label: "Every 7 days" }, { value: "720", label: "Every 30 days" }, { value: "custom", label: "Custom" }]}
        className="flex-1"
        />
        {tgForm.interval === "custom" && (
        <Input
        label="Every (hours)"
        type="number"
        min={1}
        value={tgForm.customHours}
        onChange={(e) => updateTgForm({ customHours: e.target.value })}
        placeholder="Hours"
        className="w-full sm:w-40"
        />
        )}
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-4 border-t border-border/50">
        <Button
        variant="secondary"
        icon="send"
        onClick={() => setDbAuth({ open: true, mode: "tgtest", password: "" })}
        loading={tgLoading}
        disabled={!tgHasTgToken && !tgHasGhToken}
        className="w-full sm:w-auto"
        >
        Send Test Backup
        </Button>
        <div className="flex flex-col gap-1">
          {tgForm.enabled && (
            <BackupCountdown target={tgNextRunAt} onExpire={loadAutoBackup} showDate />
          )}
          {tgLastBackup && (
          <p className="text-xs text-text-muted">
          {`Last backup: ${new Date(tgLastBackup.lastSentAt || Date.now()).toLocaleString()} (${tgLastBackup.lastStatus === "ok" ? tgLastBackup.lastChannel : "failed"})`}
          </p>
          )}
        </div>
        </div>
        {tgStatus.message && (
        <p className={`text-sm ${tgStatus.type === "error" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>
        {tgStatus.message}
        </p>
        )}
        </div>
      </Modal>

      <DownloadBackupModal
        key={downloadBackupModalKey(showDownloadBackupModal)}
        isOpen={showDownloadBackupModal}
        onClose={() => setShowDownloadBackupModal(false)}
        onDownload={(password, sections) => handleExportDatabase(password, sections)}
        loading={dbLoading}
      />


      <Modal
        isOpen={dbAuth.open}
        onClose={() => setDbAuth({ open: false, mode: "", password: "" })}
        title="Confirm Password"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDbAuth({ open: false, mode: "", password: "" })} disabled={dbLoading}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleDbAuthConfirm} loading={dbLoading} disabled={!dbAuth.password}>
              Confirm
            </Button>
          </>
        }
      >
        <p className="text-text-muted mb-3 text-sm">
          Enter your current password to {dbAuth.mode === "export" ? "export" : dbAuth.mode === "import" ? "import" : "send the database backup now"}.
        </p>
        <Input
          type="password"
          value={dbAuth.password}
          onChange={(e) => setDbAuth((s) => ({ ...s, password: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter" && dbAuth.password) handleDbAuthConfirm(); }}
          placeholder="Current password"
          autoFocus
        />
      </Modal>
    </div>
  );
}
