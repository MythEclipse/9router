"use client";

// One auto-provision per page load: two concurrent loads (StrictMode remount)
// both seeing "no keys" would each create one, leaving a duplicate behind.
let defaultKeyProvisionInFlight = false;


import { useState, useEffect, useRef, useCallback } from "react";
import { Card, Button, Input, Select, Modal, CardSkeleton, Toggle, ConfirmModal, ModelSelectModal, SegmentedControl } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { nextResetAt, formatDuration } from "@/shared/utils/interval";
import { useNow } from "@/shared/hooks/useNow";
import { TUNNEL_BENEFITS } from "./endpointConstants";
import { useTunnelExposure } from "./useTunnelExposure";
import ExposureControl, { exposureStateOf } from "./components/ExposureControl";
import {
  limitKindOf,
  limitCapOf,
  limitUsedOf,
} from "@/lib/usage/keyBudget";

import { cn } from "@/shared/utils/cn";
import useSettingsStore from "@/store/settingsStore";
import EndpointRow from "./components/EndpointRow";
import BulkEditKeys from "./components/BulkEditKeys";
import StatusAlert from "./components/StatusAlert";
import Tooltip from "./components/Tooltip";
import SecurityWarning from "./components/SecurityWarning";
import AllowedEndpointControls from "./components/AllowedEndpointControls";
import { formatTokensNumber, formatLimitValue, limitFieldLabel, limitHint, limitPlaceholder } from "./limitPresentation";

// One budget per key: the owner picks tokens, money or request count, and the UI
// shows whichever one is selected. All three caps can stay stored so switching
// back and forth does not lose the numbers.
// Each budget answers a different question, so the picker keeps all three visible and
// gives each one its own accent. A dropdown reduced this to a single grey line of text,
// which hid two thirds of the choice and made the most consequential setting in the form
// look like the least important one.
const LIMIT_KIND_OPTIONS = [
  {
    value: "tokens",
    label: "Token volume",
    blurb: "Adds up prompt and completion tokens, so a long conversation costs more than a short one.",
    icon: "data_usage",
    tone: "text-sky-400",
    tint: "bg-sky-500/10",
    chip: "bg-sky-500/15",
    border: "border-sky-500/60",
    glow: "shadow-[0_0_0_1px_rgba(56,189,248,0.25),0_8px_24px_-12px_rgba(56,189,248,0.55)]",
  },
  {
    value: "cost",
    label: "USD spend",
    blurb: "Charges every call at the model's price in USD and starts over at midnight UTC.",
    icon: "payments",
    tone: "text-emerald-400",
    tint: "bg-emerald-500/10",
    chip: "bg-emerald-500/15",
    border: "border-emerald-500/60",
    glow: "shadow-[0_0_0_1px_rgba(52,211,153,0.25),0_8px_24px_-12px_rgba(52,211,153,0.55)]",
  },
  {
    value: "requests",
    label: "Request count",
    blurb: "Counts calls instead of size, so a huge prompt and a tiny one cost the same.",
    icon: "bolt",
    tone: "text-violet-400",
    tint: "bg-violet-500/10",
    chip: "bg-violet-500/15",
    border: "border-violet-500/60",
    glow: "shadow-[0_0_0_1px_rgba(167,139,250,0.25),0_8px_24px_-12px_rgba(167,139,250,0.55)]",
  },
];

interface LimitKindPickerProps {
  value: string
  onChange(...args: unknown[]): unknown
}

function LimitKindPicker({ value, onChange }: LimitKindPickerProps) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-text-main">Limit Type</label>
      <div role="radiogroup" aria-label="Limit Type" className="flex flex-col gap-2">
        {LIMIT_KIND_OPTIONS.map((opt) => {
          const selected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(opt.value)}
              className={cn(
                // A full-width row, because the editor is a 512px column: three side-by-side
                // cards squeezed each blurb into five short lines and hid the choice again.
                "chrome-focus group flex w-full items-center gap-3 rounded-[14px] border p-3 text-left",
                "transition-all duration-[var(--motion-fast)]",
                // Unselected rows keep their accent, faint, so the list never reads as three
                // identical grey strips; selecting deepens the colour already there.
                selected
                  ? `${opt.tint} ${opt.border} ${opt.glow}`
                  : "border-border/50 bg-surface-2/40 hover:border-border hover:bg-black/5 dark:hover:bg-white/5"
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]",
                  opt.chip,
                  opt.tone,
                  selected ? "opacity-100" : "opacity-70"
                )}
              >
                <span className="material-symbols-outlined text-[19px] leading-none">{opt.icon}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm font-semibold", selected ? opt.tone : "text-text-main")}>
                  {opt.label}
                </span>
                <span className="mt-1 block text-xs leading-snug text-text-muted">{opt.blurb}</span>
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                  selected ? `${opt.border} ${opt.tone}` : "border-text-muted/50 text-transparent"
                )}
              >
                <span className={cn("h-2 w-2 rounded-full", selected ? "bg-current" : "bg-transparent")} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}


// The active budget as a badge. Colour is the only cue that the key is out of room,
// so it turns red the moment the used value reaches the cap.
function LimitBadge({ entry }) {
  const kind = limitKindOf(entry);
  const cap = limitCapOf(entry, kind);
  const used = limitUsedOf(entry, kind);
  const exhausted = cap > 0 && used >= cap;
  return (
    <span className={cn(
      "text-xs max-w-full truncate px-2 py-0.5 rounded font-medium",
      exhausted ? "bg-red-500/10 text-red-500" : "bg-primary/10 text-primary"
    )}>
      Usage: {formatLimitValue(kind, used)} / {cap > 0 ? formatLimitValue(kind, cap) : "Unlimited"}
    </span>
  );
}

// The key editor carries a dozen fields; grouping them by what they control keeps
// the form readable instead of one undifferentiated stack of inputs.
function FormSection({ icon, title, description, children }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start gap-2 pb-2 border-b border-border-subtle">
        <span className="material-symbols-outlined text-[18px] leading-6 text-text-muted">{icon}</span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-main">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

const RESET_INTERVAL_OPTIONS = [
  { value: "never", label: "Never reset" },
  { value: "5h", label: "Every 5 Hours (5h)" },
  { value: "7d", label: "Every 7 Days (7d)" },
  { value: "14d", label: "Every 14 Days (14d)" },
  { value: "30d", label: "Every 30 Days (30d)" },
  { value: "custom", label: "Custom Interval..." },
];

const PERMISSION_OPTIONS = [
  { key: "manageApiKeys", label: "Create, edit and delete API keys", icon: "key", desc: "Lets this key manage other API keys" },
  { key: "manageModels", label: "Create, edit and delete models", icon: "auto_awesome", desc: "Custom models, aliases and combos" },
  { key: "manageProviders", label: "Create, edit and delete providers", icon: "dns", desc: "Provider connections and API keys" },
  { key: "manageTools", label: "Use CLI tools and token saver", icon: "terminal", desc: "Request transformers and the CLI install page" },
  { key: "manageAdvanced", label: "Open console log, translator and proxy pools", icon: "terminal", desc: "Debugging and network plumbing" },
  { key: "managePlugins", label: "Manage custom plugins", icon: "widgets", desc: "Plugins that change how requests are handled" },
  { key: "manageMediaProviders", label: "Manage media providers", icon: "perm_media", desc: "Image, audio and embedding connections" },
  { key: "viewUsage", label: "View usage", icon: "bar_chart", desc: "Usage numbers for this key only" },
];

const EMPTY_PERMISSIONS = { manageApiKeys: false, manageModels: false, manageProviders: false, manageTools: false, manageAdvanced: false, managePlugins: false, manageMediaProviders: false, viewUsage: true };

const PERMISSIONS_LOCKED_REASON = "Locked. Sign in with the dashboard password to change permissions.";

interface ResetCountdownProps {
  resetInterval?: string
  lastResetAt?: string
}

function ResetCountdown({ resetInterval, lastResetAt }: ResetCountdownProps) {
  const now = useNow(true);
  if (!resetInterval || resetInterval === "never") return null;
  const due = nextResetAt(resetInterval, lastResetAt);
  if (!due) return null;
  const remaining = new Date(due).getTime() - now;
  return (
    <span className="text-xs max-w-full truncate px-2 py-0.5 rounded-[var(--r-chip)] bg-surface-2 text-text-muted border border-border-subtle">
      {remaining <= 0 ? "Resetting..." : `Next reset: ${formatDuration(remaining)}`}
    </span>
  );
}



interface PermissionsEditorProps {
  value?: object
  onChange(...args: unknown[]): unknown
  allowed?: object
  locked?: boolean
  lockedReason?: string
}

function PermissionsEditor({ value, onChange, allowed, locked, lockedReason }: PermissionsEditorProps) {
  // A locked editor ignores whatever the parent holds and renders the default,
  // so what the form shows is what the key will actually be created with.
  const effective = locked ? EMPTY_PERMISSIONS : value;
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-text-main">Permissions</label>
      <p className="text-xs text-text-muted">
        What this key may do once it signs in. The sidebar and the forms it opens follow these.
      </p>
      {locked && (
        <p className="mt-1 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-xs text-text-muted">
          {lockedReason}
        </p>
      )}
      <div className="flex flex-col gap-1.5 mt-1">
        {PERMISSION_OPTIONS.map((opt) => {
          const unavailable = locked || !allowed[opt.key];
          const checked = Boolean(effective?.[opt.key]);
          const note = locked ? lockedReason : unavailable ? "Your key does not hold this permission" : opt.desc;
          return (
            <label
              key={opt.key}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2.5 transition-colors",
                unavailable ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:border-primary/40"
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--color-primary)] shrink-0"
                checked={checked}
                disabled={unavailable}
                onChange={(e) => onChange({ ...EMPTY_PERMISSIONS, ...value, [opt.key]: e.target.checked })}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium text-text-main">
                  <span className="material-symbols-outlined text-[16px] text-primary">{opt.icon}</span>
                  {opt.label}
                </span>
                <span className="text-xs text-text-muted">{note}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}



function generateSnippet(lang, apiKey, baseUrl) {
  const url = `${baseUrl}/v1/chat/completions`;
  const model = "gpt-4";
  if (lang === "curl") return `curl -X POST "${url}" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello"}]}'`;
  if (lang === "python") return `import requests\n\nresp = requests.post("${url}",\n headers={"Authorization": "Bearer ${apiKey}", "Content-Type": "application/json"},\n json={"model": "${model}", "messages": [{"role": "user", "content": "Hello"}]}\n)\nprint(resp.json())`;
  if (lang === "node") return `const resp = await fetch("${url}", {\n method: "POST",\n headers: { "Authorization": "Bearer ${apiKey}", "Content-Type": "application/json" },\n body: JSON.stringify({ model: "${model}", messages: [{ role: "user", content: "Hello" }] })\n});\nconst data = await resp.json();\nconsole.log(data);`;
  if (lang === "go") return `package main\n\nimport (\n\t"bytes"\n\t"fmt"\n\t"io"\n\t"net/http"\n)\n\nfunc main() {\n\tbody := []byte(\`{"model":"${model}","messages":[{"role":"user","content":"Hello"}]}\`)\n\treq, _ := http.NewRequest("POST", "${url}", bytes.NewBuffer(body))\n\treq.Header.Set("Authorization", "Bearer ${apiKey}")\n\treq.Header.Set("Content-Type", "application/json")\n\tresp, _ := http.DefaultClient.Do(req)\n\tdefer resp.Body.Close()\n\tb, _ := io.ReadAll(resp.Body)\n\tfmt.Println(string(b))\n}`;
  return "";
}

interface APIPageClientProps {
  machineId: string
}

export default function APIPageClient({ machineId }: APIPageClientProps) {
  const [keys, setKeys] = useState([]);
  // Bulk edit: which rows are ticked, and whether the dialog is open. Nothing is
  // written until Apply, and only the fields the operator ticks are sent.
  const [selectedKeyIds, setSelectedKeyIds] = useState(() => new Set());
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyLimit, setNewKeyLimit] = useState("");
  const [newKeyReset, setNewKeyReset] = useState("never");
  const [newKeyCustomReset, setNewKeyCustomReset] = useState("");
  const [newKeyAllowedModels, setNewKeyAllowedModels] = useState("*");
  const [newKeyAllowedEndpoints, setNewKeyAllowedEndpoints] = useState([]);
  const [newKeyRpm, setNewKeyRpm] = useState("");
  const [newKeyTpm, setNewKeyTpm] = useState("");
  const [newKeyLimitKind, setNewKeyLimitKind] = useState("tokens");
  const [newKeyExpiresAt, setNewKeyExpiresAt] = useState("");
  const [editingKey, setEditingKey] = useState(null);
  const [editName, setEditName] = useState("");
  const [editLimit, setEditLimit] = useState("");
  const [editReset, setEditReset] = useState("never");
  const [editCustomReset, setEditCustomReset] = useState("");
  const [editAllowedModels, setEditAllowedModels] = useState("*");
  const [editAllowedEndpoints, setEditAllowedEndpoints] = useState([]);
  const [editRpm, setEditRpm] = useState("");
  const [editTpm, setEditTpm] = useState("");
  const [editLimitKind, setEditLimitKind] = useState("tokens");
  const [editExpiresAt, setEditExpiresAt] = useState("");
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [pickerTarget, setPickerTarget] = useState(null); // 'create' | 'edit'
  const [createdKey, setCreatedKey] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [showSnippetModal, setShowSnippetModal] = useState(null); // key object or null
  const [snippetLang, setSnippetLang] = useState("curl");

  const [requireApiKey, setRequireApiKey] = useState(false);
 const [tunnelDashboardAccess, setTunnelDashboardAccess] = useState(false);
 const [authStatus, setAuthStatus] = useState(null);
 const [newKeyPermissions, setNewKeyPermissions] = useState({ ...EMPTY_PERMISSIONS });
 const [editPermissions, setEditPermissions] = useState({ ...EMPTY_PERMISSIONS });
 const isApiKeyUser = authStatus?.role === "apikey";
 const sessionApiKey = authStatus?.apiKey || null;
 // A key that is already inside the key table cannot hand out permissions, so the
 // whole block is inert and the value it writes is the default rather than whatever
 // the form last held. The API enforces the same rule; the point here is that the
 // form does not pretend to offer a choice it will not honour.
 const permissionsLocked = isApiKeyUser;
 const permissionsToSave = (current) => (permissionsLocked ? EMPTY_PERMISSIONS : current);
  // A key cannot edit, switch off or delete itself, so those controls are dimmed
  // instead of bouncing a 403 back at the user.
  const isOwnKey = (key) => isApiKeyUser && !!key && key.key === sessionApiKey;
  const creatorPermissions = authStatus?.permissions || { ...EMPTY_PERMISSIONS, manageApiKeys: true, manageModels: true, manageProviders: true, manageTools: true, manageAdvanced: true, managePlugins: true, manageMediaProviders: true };
 const creatorTokenLimit = authStatus?.tokenLimit || 0;
 const creatorAllowedModels = authStatus?.allowedModels || "*";
// A key that is itself limited to certain models can only hand those same models on.
const scopedModelPatterns =
  isApiKeyUser && creatorAllowedModels !== "*"
    ? String(creatorAllowedModels)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    : null;

  // Cloudflare Tunnel + Tailscale lifecycle lives in one hook (see useTunnelExposure).
  const exposure = useTunnelExposure(requireApiKey, ({ requireApiKey: next, tunnelDashboardAccess: nextAccess }) => {
    setRequireApiKey(next);
    setTunnelDashboardAccess(nextAccess);
  });
  const {
    tunnelChecking, tunnelEnabled, tunnelReachable, tunnelUrl, tunnelPublicUrl,
    tunnelLoading, tunnelProgress, tunnelStatus, tunnelEverReachable,
    showEnableTunnelModal, showDisableTunnelModal,
    setShowEnableTunnelModal, setShowDisableTunnelModal, setTunnelChecking,
    setTunnelLoading, setTunnelProgress, setTunnelStatus,
    handleEnableTunnel, handleDisableTunnel,
    tsEnabled, tsReachable, tsUrl, tsLoading, tsProgress, tsStatus,
    tsAuthUrl, tsAuthLabel, tsInstalled, tsInstalling, tsInstallLog, tsSudoPassword,
    tsConnecting, showTsModal, showDisableTsModal, tsEverReachable, tsLogRef,
    setShowTsModal, setShowDisableTsModal, setTsStatus, setTsSudoPassword,
    setTsLoading, setTsConnecting, setTsProgress,
    handleInstallTailscale, handleConnectTailscale, handleDisableTailscale,
    handleOpenTsModal, clearUserAuth,
    loadSettings,
  } = exposure;

  // API key visibility toggle state
  const [visibleKeys, setVisibleKeys] = useState(new Set());

  const isRemoteHost = (() => {
    if (typeof window === "undefined") return false;
    return !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  })();

  const { copied, copy } = useCopyToClipboard();

  const fetchData = async () => {
    try {
      const fetchKeys = async () => {
        const res = await fetch("/api/keys");
        if (!res.ok) return [];
        const data = await res.json();
        return data.keys || [];
      };

      const fetchProvidersAndAliases = async () => {
        try {
          const [providersRes, aliasesRes] = await Promise.all([
            fetch("/api/providers"),
            fetch("/api/models/alias"),
          ]);
          if (providersRes.ok) {
            const pData = await providersRes.json();
            setActiveProviders(pData.connections || []);
          }
          if (aliasesRes.ok) {
            const aData = await aliasesRes.json();
            setModelAliases(aData.aliases || {});
          }
        } catch (e) {
          console.error("Error fetching providers/aliases:", e);
        }
      };

      fetchProvidersAndAliases();

      let existing = await fetchKeys();
      // Auto-provision a default key for first-time users so the endpoint works out of the box.
      if (existing.length === 0 && !defaultKeyProvisionInFlight) {
        defaultKeyProvisionInFlight = true;
        try {
          const createRes = await fetch("/api/keys", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Default Keys" }),
          });
          if (createRes.ok) existing = await fetchKeys();
        } catch { /* fall through to empty render */ }
        finally { defaultKeyProvisionInFlight = false; }
      }
      setKeys(existing);
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleTunnelDashboardAccess = async (value: boolean) => {
    try {
      const updated = await useSettingsStore
        .getState()
        .patchSettings({ tunnelDashboardAccess: value });
      if (updated) setTunnelDashboardAccess(value);
    } catch (error) {
      console.error("Error updating tunnelDashboardAccess:", error);
    }
  };

  const handleRequireApiKey = async (value: boolean) => {
    try {
      const updated = await useSettingsStore.getState().patchSettings({ requireApiKey: value });
      if (updated) setRequireApiKey(value);
    } catch (error) {
      console.error("Error updating requireApiKey:", error);
    }
  };

  const handleBulkEditApply = async (patch: Record<string, unknown>) => {
    const ids = Array.from(selectedKeyIds);
    const res = await fetch("/api/keys/bulk", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, patch }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || "Failed to apply bulk changes");
    }
    if (data.missing && data.missing.length) {
      // Rows deleted elsewhere since the list loaded: drop them from the
      // selection so a second Apply does not keep reporting them.
      setSelectedKeyIds((prev) => {
        const next = new Set(prev);
        for (const id of data.missing) next.delete(id);
        return next;
      });
    }
    setShowBulkEdit(false);
    await fetchData();
  };

  useEffect(() => {
    fetch("/api/auth/status")
      .then(res => res.json())
      .then(data => setAuthStatus(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Both loaders only publish into state from their awaited HTTP responses,
    // so the initial sweep never renders synchronously with the effect body.
    const load = () => {
      void fetchData();
      void loadSettings();
    };
    load();
  }, [loadSettings]);


  const parseAllowedModelsList = (str) => {
    if (!str || str.trim() === "*" || str.trim() === "") return [];
    return str
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const setAllowedModelsList = (target, list) => {
    const joined = list.length === 0 ? "*" : list.join(", ");
    if (target === "create") setNewKeyAllowedModels(joined);
    else if (target === "edit") setEditAllowedModels(joined);
  };

  const currentAllowedModels = (target) =>
    parseAllowedModelsList(target === "create" ? newKeyAllowedModels : target === "edit" ? editAllowedModels : "");

  const addAllowedModel = (target, modelVal) => {
    const list = currentAllowedModels(target);
    if (!modelVal || list.includes(modelVal)) return;
    setAllowedModelsList(target, [...list, modelVal]);
  };

  const removeAllowedModel = (target, modelVal) => {
    setAllowedModelsList(target, currentAllowedModels(target).filter((m) => m !== modelVal));
  };

  // The picker modal serves whichever form opened it, so it routes by pickerTarget.
  const handleSelectModelForPicker = (model) => addAllowedModel(pickerTarget, model?.value);
  const handleDeselectModelForPicker = (model) => removeAllowedModel(pickerTarget, model?.value);


  const closeAddModal = () => {
    setShowAddModal(false);
    setNewKeyName("");
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;
 const trimmedName = newKeyName.trim();
 if (keys.some((k) => k.name === trimmedName)) {
 alert(`A key named "${trimmedName}" already exists. Use a different name.`);
 return;
 }

    const limitNum = newKeyLimit ? Number(newKeyLimit) : 0;
    let finalReset = "never";
    if (limitNum > 0) {
      finalReset = newKeyReset === "custom" ? (newKeyCustomReset.trim() || "never") : newKeyReset;
    }

    if (newKeyLimitKind === "tokens" && creatorTokenLimit > 0 && limitNum > creatorTokenLimit) {
      alert(`Token limit cannot exceed your maximum (${creatorTokenLimit}).`);
      return;
    }

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newKeyName,
          limitKind: newKeyLimitKind,
          tokenLimit: newKeyLimitKind === "tokens" ? limitNum : 0,
          requestLimit: newKeyLimitKind === "requests" ? limitNum : 0,
          dailyCostLimit: newKeyLimitKind === "cost" ? limitNum : 0,
          resetInterval: finalReset,
          allowedModels: newKeyAllowedModels.trim() || "*",
          allowedEndpoints: newKeyAllowedEndpoints,
          rpmLimit: newKeyRpm ? Number(newKeyRpm) : 0,
          tpmLimit: newKeyTpm ? Number(newKeyTpm) : 0,
          expiresAt: newKeyExpiresAt || null,
          permissions: permissionsToSave(newKeyPermissions),
        }),
      });
      const data = await res.json();

      if (res.ok) {
        setCreatedKey(data.key);
        await fetchData();
        setNewKeyName("");
        setNewKeyLimit("");
        setNewKeyReset("never");
        setNewKeyCustomReset("");
        setNewKeyAllowedModels("*");
        setNewKeyAllowedEndpoints([]);
        setNewKeyRpm("");
        setNewKeyTpm("");
        setNewKeyLimitKind("tokens");
        setShowAddModal(false);
        setNewKeyExpiresAt("");
        setNewKeyPermissions(EMPTY_PERMISSIONS);
 } else {
 alert(data?.error || "Failed to create key");
 }
    } catch (error) {
      console.log("Error creating key:", error);
    }
  };

 const handleDuplicateKey = (sourceKey) => {
 // Suggest a unique name like "X (copy)" / "X (copy 2)"
 let base = `${sourceKey.name} (copy)`;
 let candidate = base;
 let n = 2;
 while (keys.some((k) => k.name === candidate)) {
 candidate = `${base} ${n}`;
 n += 1;
 }
 setNewKeyName(candidate);
 setNewKeyLimitKind(limitKindOf(sourceKey));
 setNewKeyLimit(limitCapOf(sourceKey) ? String(limitCapOf(sourceKey)) : "");
 const resVal = sourceKey.resetInterval || "never";
 if (["never", "5h", "7d", "14d", "30d"].includes(resVal)) {
 setNewKeyReset(resVal);
 setNewKeyCustomReset("");
 } else {
 setNewKeyReset("custom");
 setNewKeyCustomReset(resVal);
 }
 setNewKeyAllowedModels(sourceKey.allowedModels || "*");
 setNewKeyAllowedEndpoints(sourceKey.allowedEndpoints || []);
 setNewKeyRpm(sourceKey.rpmLimit ? String(sourceKey.rpmLimit) : "");
 setNewKeyTpm(sourceKey.tpmLimit ? String(sourceKey.tpmLimit) : "");
 setNewKeyExpiresAt(sourceKey.expiresAt || "");
 setNewKeyPermissions(sourceKey.permissions || EMPTY_PERMISSIONS);
 setShowAddModal(true);
 };

  const handleUpdateKeyQuota = async (id, data) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setEditingKey(null);
      } else {
        const errBody = await res.json().catch(() => ({}));
        alert(errBody?.error || "Failed to update key");
      }
    } catch (error) {
      console.log("Error updating key:", error);
    }
  };

  // The edit modal collects many fields; the payload is assembled here so the
  // button stays a one-liner and every field is written in one place.
  const handleSaveEditedKey = () => {
    if (!editingKey) return;
    const limitNum = editLimit ? Number(editLimit) : 0;
    const finalReset = limitNum > 0
      ? (editReset === "custom" ? (editCustomReset.trim() || "never") : editReset)
      : "never";

    handleUpdateKeyQuota(editingKey.id, {
      name: editName.trim() || editingKey.name,
      limitKind: editLimitKind,
      tokenLimit: editLimitKind === "tokens" ? limitNum : 0,
      requestLimit: editLimitKind === "requests" ? limitNum : 0,
      dailyCostLimit: editLimitKind === "cost" ? limitNum : 0,
      resetInterval: finalReset,
      allowedModels: editAllowedModels.trim() || "*",
      allowedEndpoints: editAllowedEndpoints,
      rpmLimit: editRpm ? Number(editRpm) : 0,
      tpmLimit: editTpm ? Number(editTpm) : 0,
      expiresAt: editExpiresAt || null,
      permissions: permissionsToSave(editPermissions),
    });
  };

  const handleToggleKeyActive = async (key, isActive) => {
    const previous = key.isActive !== false;
    setKeys((prev) => prev.map((k) => (k.id === key.id ? { ...k, isActive } : k)));
    try {
      const res = await fetch(`/api/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        alert(errBody?.error || "Failed to update the key state.");
        setKeys((prev) => prev.map((k) => (k.id === key.id ? { ...k, isActive: previous } : k)));
      return;
    }
    } catch (error) {
      console.log("Error updating key state:", error);
      setKeys((prev) => prev.map((k) => (k.id === key.id ? { ...k, isActive: previous } : k)));
    }
    await fetchData();
  };

  const handleManualResetUsage = async (key) => {
    setConfirmState({
      title: "Reset Token Usage",
      message: `Reset used tokens for "${key.name}" back to 0?`,
      onConfirm: async () => {
        setConfirmState(null);
        await handleUpdateKeyQuota(key.id, {
          usedTokens: 0,
          lastResetAt: new Date().toISOString(),
        });
      },
    });
  };

  const handleDeleteKey = async (id) => {
    setConfirmState({
      title: "Delete API Key",
      message: "Delete this API key?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
          if (res.ok) {
            setKeys(keys.filter((k) => k.id !== id));
            setVisibleKeys((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          } else {
            const errBody = await res.json().catch(() => null);
            alert(errBody?.error || "Delete failed");
          }
        } catch (error) {
          console.log("Error deleting key:", error);
        }
      },
    });
  };

  const maskKey = (fullKey) => {
    if (!fullKey || fullKey.length <= 10) return fullKey || "";
    return fullKey.slice(0, 6) + "•".repeat(fullKey.length - 10) + fullKey.slice(-4);
  };

  const toggleKeyVisibility = (keyId) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

  // Small "who made this key" label under the key name. The server resolves the
  // creator to a name, so the raw creator key never has to travel to the browser;
  // the same wording rules live in one helper so both key pages read alike.
  const creatorLabelFor = (key) => {
    const creator = key?.createdByName || "";
    if (creator) return `Created by ${creator}`;
    if (key?.createdBy === "dashboard") return "Created by dashboard";
    return "";
  };

  const [baseUrl] = useState(() => {
    if (typeof window !== "undefined") {
      return `${window.location.origin}/v1`;
    }
    return "/v1";
  });

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const currentEndpoint = baseUrl;
  // The two exposure rows render through one state chart (see ExposureControl), so
  // the flags are folded here rather than re-tested in the JSX.
  const tunnelExposureState = exposureStateOf({
    enabled: tunnelEnabled,
    loading: tunnelLoading,
    reachable: tunnelReachable,
    checking: tunnelChecking,
    hasError: tunnelStatus?.type === "error",
  });
  const tsExposureState = exposureStateOf({
    enabled: tsEnabled,
    loading: tsLoading,
    reachable: tsReachable,
    connecting: tsConnecting,
    hasError: tsStatus?.type === "error",
  });

  return (
    <div className="flex flex-col gap-8">
      {/* Endpoint Card */}
      <Card>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">api</span>
          API Endpoint
        </h2>

        {/* Endpoint rows */}
        <div className="flex flex-col gap-2">
          {/* Local */}
          <EndpointRow
            label="Local"
            url={currentEndpoint}
            copyId="local_url"
            copied={copied}
            onCopy={copy}
          />
          {/* Exposure rows stay with the administrator: a key-signed session only
              manages keys, it never republishes the endpoint. */}
          {!isApiKeyUser && (
          <>
          <ExposureControl
            label="Tunnel"
            state={tunnelExposureState}
            url={tunnelPublicUrl || tunnelUrl}
            copyId="tunnel_url"
            copied={copied}
            onCopy={copy}
            progress={tunnelProgress || "Creating tunnel..."}
            degradedText={tunnelEverReachable ? "Tunnel reconnecting..." : "Tunnel checking..."}
            errorMessage={tunnelStatus?.message || ""}
            enableIcon="cloud_upload"
            blockedReason={requireApiKey ? undefined : 'Security required: Enable "Require API key" before activating the tunnel.'}
            onEnable={() => setShowEnableTunnelModal(true)}
            onDisable={() => setShowDisableTunnelModal(true)}
            onStop={() => {
              setTunnelLoading(false);
              setTunnelProgress("");
            }}
            onBlocked={(message) => setTunnelStatus({ type: "error", message })}
          />
          <ExposureControl
            label="Tailscale"
            state={tsExposureState}
            url={tsUrl}
            copyId="ts_url"
            copied={copied}
            onCopy={copy}
            progress={tsProgress || "Connecting..."}
            degradedText={tsEverReachable ? "Tailscale reconnecting..." : "Tailscale checking..."}
            errorMessage={tsStatus?.message || ""}
            authUrl={tsAuthUrl}
            authLabel={tsAuthLabel}
            enableIcon="vpn_lock"
            enableClassName="bg-linear-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 text-white!"
            onEnable={() => handleOpenTsModal()}
            onDisable={() => setShowDisableTsModal(true)}
            onStop={() => {
              setTsLoading(false);
              setTsConnecting(false);
              setTsProgress("");
              clearUserAuth();
            }}
            onBlocked={(message) => setTsStatus({ type: "error", message })}
          />
          </>
          )}
        </div>

        {/* Security warnings when tunnel or tailscale is active */}
        {!isApiKeyUser && (tunnelEnabled || tsEnabled) && (
          <div className="mt-4 flex flex-col gap-2">
            {!requireApiKey && (
              <SecurityWarning
                message="Require API key is disabled - your endpoint is publicly accessible without authentication."
                action={{ label: "Enable", href: "#require-api-key" }}
              />
            )}
          </div>
        )}

        {/* Tunnel dashboard access option */}
        {!isApiKeyUser && (tunnelEnabled || tsEnabled) && (
          <div className="mt-4 pt-4 border-t border-border flex flex-wrap items-center gap-3">
            <Toggle
              checked={tunnelDashboardAccess}
              className="flex-shrink-0"
              onChange={() => handleTunnelDashboardAccess(!tunnelDashboardAccess)}
            />
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <p className="font-medium text-sm">Allow dashboard access via tunnel</p>
              <Tooltip text="Open the dashboard through the tunnel or Tailscale URL (login still required), or keep it blocked when disabled" />
            </div>
          </div>
        )}
      </Card>

      {/* API Keys */}
      <Card id="require-api-key">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">vpn_key</span>
            API Keys
          </h2>
          <Button icon="add" onClick={() => setShowAddModal(true)}>
            Create Key
          </Button>
        </div>

        {!isApiKeyUser && (
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 mb-4 border-b border-border">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Require API key</p>
            <p className="text-sm text-text-muted">Requests without a valid key will be rejected</p>
          </div>
          <Toggle
            checked={requireApiKey}
            className="flex-shrink-0"
            onChange={() => handleRequireApiKey(!requireApiKey)}
          />
        </div>
        )}

        {!isApiKeyUser && isRemoteHost && !requireApiKey && (
          <div className="mb-4 -mt-2">
            <SecurityWarning message="Endpoint is exposed without an API key." />
          </div>
        )}

        {!isApiKeyUser && selectedKeyIds.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3 rounded-xl border border-primary/25 bg-primary/5 px-3.5 py-2.5">
            <span className="text-sm text-text-main">
              {selectedKeyIds.size} key{selectedKeyIds.size === 1 ? "" : "s"} selected
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedKeyIds(new Set())}
                className="text-xs text-text-muted hover:text-text-main transition-colors"
              >
                Clear selection
              </button>
              <Button variant="primary" onClick={() => setShowBulkEdit(true)}>
                Bulk edit
              </Button>
            </div>
          </div>
        )}

        {keys.length === 0 ? (
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">vpn_key</span>
            </div>
            <p className="text-text-main font-medium mb-1">No API keys yet</p>
            <p className="text-sm text-text-muted mb-4">Create your first API key to get started</p>
            <Button icon="add" onClick={() => setShowAddModal(true)}>
              Create Key
            </Button>
          </div>
        ) : (
          <div className="flex flex-col">
            {keys.map((key) => (
              <div
                key={key.id}
                className={`group flex flex-wrap items-start justify-between gap-3 py-3 border-b border-black/[0.03] dark:border-white/[0.03] last:border-b-0 ${key.isActive === false ? "opacity-60" : ""}`}
              >
                {!isApiKeyUser && (
                  <input
                    type="checkbox"
                    checked={selectedKeyIds.has(key.id)}
                    onChange={() => {
                      setSelectedKeyIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(key.id)) next.delete(key.id);
                        else next.add(key.id);
                        return next;
                      });
                    }}
                    className="size-4 accent-brand-500 shrink-0 mt-0.5"
                    aria-label={`Select ${key.name}`}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate min-w-0">{key.name}</p>
                  {creatorLabelFor(key) && (
                    <p className="text-xs text-text-muted truncate min-w-0">{creatorLabelFor(key)}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5 mt-1 min-w-0">
                    <code className="text-xs text-text-muted font-mono break-all max-w-[200px] sm:max-w-xs min-w-0">
                      {visibleKeys.has(key.id) ? key.key : maskKey(key.key)}
                    </code>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => toggleKeyVisibility(key.id)}
                        className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-all"
                        title={visibleKeys.has(key.id) ? "Hide key" : "Show key"}
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {visibleKeys.has(key.id) ? "visibility_off" : "visibility"}
                        </span>
                      </button>
                      <button
                        onClick={() => copy(key.key, key.id)}
                        className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-all"
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {copied === key.id ? "check" : "content_copy"}
                        </span>
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-text-muted mt-1">
                    Created {new Date(key.createdAt).toLocaleDateString()}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5 mt-2 overflow-hidden">
                    <LimitBadge entry={key} />
                    {limitKindOf(key) !== "cost" && limitCapOf(key) > 0 && key.resetInterval && key.resetInterval !== "never" && (
                      <ResetCountdown resetInterval={key.resetInterval} lastResetAt={key.lastResetAt} />
                    )}
                    <span className="text-xs max-w-full truncate px-2 py-0.5 rounded bg-blue-500/10 text-blue-500 font-medium">
                      Models: {key.allowedModels && key.allowedModels !== "*" ? key.allowedModels : "All"}
                    </span>
                    <span className="text-xs max-w-full truncate px-2 py-0.5 rounded bg-teal-500/10 text-teal-600 font-medium">
                      Endpoints: {key.allowedEndpoints?.length ? key.allowedEndpoints.join(", ") : "All"}
                    </span>
                    {(key.rpmLimit > 0 || key.tpmLimit > 0) && (
                      <span className="text-xs max-w-full truncate px-2 py-0.5 rounded bg-purple-500/10 text-purple-500 font-medium">
                        Rate: {key.rpmLimit > 0 ? `${key.rpmLimit} RPM` : ""}{key.rpmLimit > 0 && key.tpmLimit > 0 ? " · " : ""}{key.tpmLimit > 0 ? `${formatTokensNumber(key.tpmLimit)} TPM` : ""}
                      </span>
                    )}
                    {key.expiresAt && (() => {
                      const expDate = new Date(key.expiresAt);
                      const isExpired = expDate.getTime() < Date.now();
                      return (
                        <span className={`inline-flex items-center gap-1 text-xs max-w-full truncate px-2 py-0.5 rounded font-medium ${
                          isExpired
                            ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/20"
                            : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                        }`}>
                          <span className="material-symbols-outlined text-[13px] leading-none">
                            {isExpired ? "event_busy" : "timer"}
                          </span>
                          {isExpired ? "Expired: " : "Expires: "}
                          {expDate.toLocaleDateString()} {expDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      );
                    })()}
                  </div>
                </div>
                <div className="flex-shrink-0 items-center gap-1.5">
                  <div
                    className="inline-flex items-center px-1"
                    title={key.isActive === false ? "Switch this key back on" : "Switch this key off"}
                  >
                  <Toggle
                    size="sm"
                    checked={key.isActive !== false}
                    disabled={isOwnKey(key)}
                    onChange={(nextActive) => handleToggleKeyActive(key, nextActive)}
                  />
                  </div>
                <button
                  onClick={() => {
                    setEditingKey(key);
                      setEditName(key.name || "");
                      const lim = limitCapOf(key) ? String(limitCapOf(key)) : "";
                      setEditLimit(lim);
                      setEditLimitKind(limitKindOf(key));
                      const resVal = key.resetInterval || "never";
                      if (["never", "5h", "7d", "14d", "30d"].includes(resVal)) {
                        setEditReset(resVal);
                        setEditCustomReset("");
                      } else {
                        setEditReset("custom");
                        setEditCustomReset(resVal);
                      }
                      setEditAllowedModels(key.allowedModels || "*");
                      setEditAllowedEndpoints(key.allowedEndpoints || []);
                      setEditRpm(key.rpmLimit ? String(key.rpmLimit) : "");
                      setEditTpm(key.tpmLimit ? String(key.tpmLimit) : "");
                      setEditExpiresAt(key.expiresAt || "");
                      setEditPermissions(key.permissions || EMPTY_PERMISSIONS);
                    }}
                    disabled={isOwnKey(key)}
                    className={cn("p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-all", isOwnKey(key) && "opacity-40 cursor-not-allowed")}
                    title="Edit key settings & quota"
                  >
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
 <button
 onClick={() => handleDuplicateKey(key)}
 className={cn("p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-all", isOwnKey(key) && "opacity-40 cursor-not-allowed")}
 title="Duplicate key (copy settings)"
 >
 <span className="material-symbols-outlined text-[18px]">library_add</span>
 </button>
                  <button
                    onClick={() => handleManualResetUsage(key)}
                    disabled={isOwnKey(key)}
                    className={cn("p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-all", isOwnKey(key) && "opacity-40 cursor-not-allowed")}
                    title="Reset used tokens to 0"
                  >
                    <span className="material-symbols-outlined text-[18px]">restart_alt</span>
                  </button>
          <button
            onClick={() => { setShowSnippetModal(key); setSnippetLang("curl"); }}
            className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-all"
            title="Code snippet"
          >
            <span className="material-symbols-outlined text-[18px]">code</span>
          </button>
                  <button
                    onClick={() => handleDeleteKey(key.id)}
                    disabled={isOwnKey(key)}
                    className={cn("p-2 hover:bg-red-500/10 rounded text-red-500 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all", isOwnKey(key) && "opacity-30 cursor-not-allowed")}
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Add Key Modal */}
      <Modal
        isOpen={showAddModal}
        title="Create API Key"
        size="lg"
        onClose={closeAddModal}
        footer={
          <>
            <Button onClick={closeAddModal} variant="ghost">
              Cancel
            </Button>
            <Button onClick={handleCreateKey} disabled={!newKeyName.trim()} icon="add">
              Create Key
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <FormSection
            icon="badge"
            title="Identity"
            description="What you will see in the key list, and how long the key may live."
          >
            <Input
              label="Key Name"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Production Key"
            />
            <Input
              label="Expiry Date (optional)"
              type="datetime-local"
              value={newKeyExpiresAt}
              onChange={(e) => setNewKeyExpiresAt(e.target.value)}
              hint="Key stops working after this date; leave empty for no expiry"
            />
          </FormSection>

          <FormSection
            icon="speed"
            title="Usage Limit"
            description="One budget is enforced per key. Pick the unit it is measured in."
          >
            <LimitKindPicker value={newKeyLimitKind} onChange={setNewKeyLimitKind} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label={limitFieldLabel(newKeyLimitKind)}
                type="number"
                step={newKeyLimitKind === "cost" ? "0.01" : "1"}
                min="0"
                value={newKeyLimit}
                onChange={(e) => setNewKeyLimit(e.target.value)}
                placeholder={limitPlaceholder(newKeyLimitKind)}
                hint={limitHint(newKeyLimitKind, creatorTokenLimit)}
              />
            </div>
            {newKeyLimitKind !== "cost" && Number(newKeyLimit) > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Select
                  label="Auto Reset Interval"
                  options={RESET_INTERVAL_OPTIONS}
                  value={newKeyReset}
                  onChange={(e) => setNewKeyReset(e.target.value)}
                />
                {newKeyReset === "custom" && (
                  <Input
                    label="Custom Interval"
                    value={newKeyCustomReset}
                    onChange={(e) => setNewKeyCustomReset(e.target.value)}
                    placeholder="10h"
                    hint="e.g. 10h, 3d"
                  />
                )}
              </div>
            )}
          </FormSection>

          <FormSection
            icon="bolt"
            title="Rate Limits"
            description="Per-minute ceilings, enforced on their own."
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="RPM Limit"
                type="number"
                value={newKeyRpm}
                onChange={(e) => setNewKeyRpm(e.target.value)}
                placeholder="0"
                hint="Max requests per minute; 0 = unlimited"
              />
              <Input
                label="TPM Limit"
                type="number"
                value={newKeyTpm}
                onChange={(e) => setNewKeyTpm(e.target.value)}
                placeholder="0"
                hint="Max tokens per minute; 0 = unlimited"
              />
            </div>
          </FormSection>

          <FormSection
            icon="admin_panel_settings"
            title="Access"
            description="Which models and API endpoints the key may call, and what it may do in the dashboard."
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-text-main">
                  Allowed Models
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="add"
                  onClick={() => {
                    setPickerTarget("create");
                    setShowModelPicker(true);
                  }}
                >
                  Select Models
                </Button>
              </div>
              <Input
                value={newKeyAllowedModels}
                readOnly
                inputClassName="truncate font-mono"
                hint={isApiKeyUser && creatorAllowedModels !== "*" ? `Limited to your allowed models: ${creatorAllowedModels}` : "Pick models with Select Models. * allows all models."}
              />
              {parseAllowedModelsList(newKeyAllowedModels).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {parseAllowedModelsList(newKeyAllowedModels).map((m) => (
                    <span
                      key={m}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 text-primary font-mono text-xs"
                    >
                      {m}
                      <button
                        type="button"
                        onClick={() => removeAllowedModel("create", m)}
                        className="hover:text-red-500 transition-colors"
                      >
                        <span className="material-symbols-outlined text-[14px]">close</span>
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <AllowedEndpointControls
              value={newKeyAllowedEndpoints}
              onChange={setNewKeyAllowedEndpoints}
            />
            <PermissionsEditor
              value={newKeyPermissions}
              onChange={setNewKeyPermissions}
              allowed={creatorPermissions}
              locked={permissionsLocked}
              lockedReason={PERMISSIONS_LOCKED_REASON}
            />
          </FormSection>
        </div>
      </Modal>

      {/* Edit Key Modal */}
      <Modal
        isOpen={!!editingKey}
        title={`Edit API Key: ${editingKey?.name || ""}`}
        size="lg"
        onClose={() => setEditingKey(null)}
        footer={
          <>
            <Button onClick={() => setEditingKey(null)} variant="ghost">
              Cancel
            </Button>
            <Button onClick={handleSaveEditedKey} icon="save">
              Save Changes
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <FormSection
            icon="badge"
            title="Identity"
            description="What you will see in the key list, and how long the key may live."
          >
            <Input
              label="Key Name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Production Key"
            />
            <Input
              label="Expiry Date (optional)"
              type="datetime-local"
              value={editExpiresAt}
              onChange={(e) => setEditExpiresAt(e.target.value)}
              hint="Key stops working after this date; leave empty for no expiry"
            />
          </FormSection>

          <FormSection
            icon="speed"
            title="Usage Limit"
            description="One budget is enforced per key. Pick the unit it is measured in."
          >
            <LimitKindPicker value={editLimitKind} onChange={setEditLimitKind} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label={limitFieldLabel(editLimitKind)}
                type="number"
                step={editLimitKind === "cost" ? "0.01" : "1"}
                min="0"
                value={editLimit}
                onChange={(e) => setEditLimit(e.target.value)}
                placeholder={limitPlaceholder(editLimitKind)}
                hint={limitHint(editLimitKind, creatorTokenLimit)}
              />
            </div>
            {editLimitKind !== "cost" && Number(editLimit) > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Select
                  label="Auto Reset Interval"
                  options={RESET_INTERVAL_OPTIONS}
                  value={editReset}
                  onChange={(e) => setEditReset(e.target.value)}
                />
                {editReset === "custom" && (
                  <Input
                    label="Custom Interval"
                    value={editCustomReset}
                    onChange={(e) => setEditCustomReset(e.target.value)}
                    placeholder="10h"
                    hint="e.g. 10h, 3d"
                  />
                )}
              </div>
            )}
          </FormSection>

          <FormSection
            icon="bolt"
            title="Rate Limits"
            description="Per-minute ceilings, enforced on their own."
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="RPM Limit"
                type="number"
                value={editRpm}
                onChange={(e) => setEditRpm(e.target.value)}
                placeholder="0"
                hint="Max requests per minute; 0 = unlimited"
              />
              <Input
                label="TPM Limit"
                type="number"
                value={editTpm}
                onChange={(e) => setEditTpm(e.target.value)}
                placeholder="0"
                hint="Max tokens per minute; 0 = unlimited"
              />
            </div>
          </FormSection>

          <FormSection
            icon="admin_panel_settings"
            title="Access"
            description="Which models and API endpoints the key may call, and what it may do in the dashboard."
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-text-main">
                  Allowed Models
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="add"
                  onClick={() => {
                    setPickerTarget("edit");
                    setShowModelPicker(true);
                  }}
                >
                  Select Models
                </Button>
              </div>
              <Input
                value={editAllowedModels}
                readOnly
                inputClassName="truncate font-mono"
                hint="Pick models with Select Models. * allows all models."
              />
              {parseAllowedModelsList(editAllowedModels).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {parseAllowedModelsList(editAllowedModels).map((m) => (
                    <span
                      key={m}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 text-primary font-mono text-xs"
                    >
                      {m}
                      <button
                        type="button"
                        onClick={() => removeAllowedModel("edit", m)}
                        className="hover:text-red-500 transition-colors"
                      >
                        <span className="material-symbols-outlined text-[14px]">close</span>
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <AllowedEndpointControls
              value={editAllowedEndpoints}
              onChange={setEditAllowedEndpoints}
            />
            <PermissionsEditor
              value={editPermissions}
              onChange={setEditPermissions}
              allowed={creatorPermissions}
              locked={permissionsLocked}
              lockedReason={PERMISSIONS_LOCKED_REASON}
            />
          </FormSection>
        </div>
      </Modal>

      {/* Created Key Modal */}
      <Modal isOpen={!!createdKey} title="API Key Created" onClose={() => setCreatedKey(null)}>
        <div className="flex flex-col gap-4">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">
              Save this key now!
            </p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              Store this key now, because it is shown only once.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={createdKey || ""}
              readOnly
              className="flex-1 min-w-0 font-mono text-sm" inputClassName="truncate"
            />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              className="flex-shrink-0"
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      {/* Model Select Modal for API Keys */}
      {showModelPicker && (
        <ModelSelectModal
          isOpen={showModelPicker}
          onClose={() => setShowModelPicker(false)}
          onSelect={handleSelectModelForPicker}
          onDeselect={handleDeselectModelForPicker}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Select Allowed Models"
          addedModelValues={parseAllowedModelsList(pickerTarget === "create" ? newKeyAllowedModels : editAllowedModels)}
          allowedModelPatterns={scopedModelPatterns}
          closeOnSelect={false}
        />
      )}

      {/* Enable Tunnel Modal */}
      <Modal
        isOpen={showEnableTunnelModal}
        title="Enable Tunnel"
        onClose={() => setShowEnableTunnelModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-surface-2 border border-border-subtle rounded-lg p-4">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-primary">cloud_upload</span>
              <div>
                <p className="text-sm text-text-main font-medium mb-1">Cloudflare Tunnel</p>
                <p className="text-sm text-text-muted">
                  Expose your local 9Router to the internet without port forwarding or a static IP, then use the URL in Cursor, Cline, and other tools from anywhere.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {TUNNEL_BENEFITS.map((benefit) => (
              <div
                key={benefit.title}
                className="flex flex-col items-center text-center p-3 rounded-lg bg-sidebar/50"
              >
                <span className="material-symbols-outlined text-xl text-primary mb-1">
                  {benefit.icon}
                </span>
                <p className="text-xs font-semibold">{benefit.title}</p>
                <p className="text-xs text-text-muted">{benefit.desc}</p>
              </div>
            ))}
          </div>

          <p className="text-xs text-text-muted">
            Needs outbound port 7844 (TCP/UDP) and may take 10-30s to connect.
          </p>

          <div className="flex gap-2">
            <Button onClick={handleEnableTunnel} fullWidth>
              Start Tunnel
            </Button>
            <Button onClick={() => setShowEnableTunnelModal(false)} variant="ghost" fullWidth>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Disable Cloudflare Tunnel Modal */}
      <Modal
        isOpen={showDisableTunnelModal}
        title="Disable Tunnel"
        onClose={() => !tunnelLoading && setShowDisableTunnelModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">The Cloudflare tunnel will disconnect and its URL will stop working.</p>
          <div className="flex gap-2">
            <Button
              onClick={handleDisableTunnel}
              fullWidth
              disabled={tunnelLoading}
              variant="danger"
            >
              {tunnelLoading ? "Disabling..." : "Disable"}
            </Button>
            <Button
              onClick={() => setShowDisableTunnelModal(false)}
              variant="ghost"
              fullWidth
              disabled={tunnelLoading}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Tailscale Modal */}
      <Modal
        isOpen={showTsModal}
        title="Tailscale Funnel"
        onClose={() => {
          if (!tsInstalling) {
            setShowTsModal(false);
            setTsSudoPassword("");
            setTsStatus(null);
          }
        }}
      >
        <div className="flex flex-col gap-4">
          {/* Checking state */}
          {tsInstalled === null && (
            <p className="text-sm text-text-muted flex items-center gap-2">
              <span className="material-symbols-outlined animate-spin text-sm">
                progress_activity
              </span>
              Checking...
            </p>
          )}

          {/* Not installed */}
          {tsInstalled === false && !tsInstalling && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-muted">Install Tailscale to enable Funnel.</p>
              <div className="flex gap-2">
                <Button onClick={handleInstallTailscale} fullWidth>
                  Install Tailscale
                </Button>
                <Button onClick={() => setShowTsModal(false)} variant="ghost" fullWidth>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Installing with progress log */}
          {tsInstalling && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <span className="material-symbols-outlined animate-spin text-sm">
                  progress_activity
                </span>
                Installing Tailscale...
              </div>
              {tsInstallLog.length > 0 && (
                <div
                  ref={tsLogRef}
                  className="bg-black/5 dark:bg-white/5 rounded p-2 max-h-40 overflow-y-auto font-mono text-xs text-text-muted"
                >
                  {tsInstallLog.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Installed: show Connect button */}
          {tsInstalled === true && !tsInstalling && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <span className="material-symbols-outlined text-[16px]">check_circle</span>
                Tailscale installed
              </div>
              <div className="flex gap-2">
                <Button onClick={() => handleConnectTailscale()} fullWidth>
                  Connect
                </Button>
                <Button onClick={() => setShowTsModal(false)} variant="ghost" fullWidth>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {tsStatus && <StatusAlert status={tsStatus} />}
        </div>
      </Modal>

      {/* Disable Tailscale Modal */}
      <Modal
        isOpen={showDisableTsModal}
        title="Disable Tailscale"
        onClose={() => !tsLoading && setShowDisableTsModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">Tailscale Funnel will stop and its URL will become unreachable.</p>
          <div className="flex gap-2">
            <Button
              onClick={handleDisableTailscale}
              fullWidth
              disabled={tsLoading}
              variant="danger"
            >
              {tsLoading ? "Disabling..." : "Disable"}
            </Button>
            <Button
              onClick={() => setShowDisableTsModal(false)}
              variant="ghost"
              fullWidth
              disabled={tsLoading}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Snippet Modal */}
<Modal
  isOpen={!!showSnippetModal}
  title="Code Snippet"
  onClose={() => setShowSnippetModal(null)}
>
  <div className="flex flex-col gap-4">
 <SegmentedControl
 options={[
 { value: "curl", label: "cURL" },
 { value: "python", label: "Python" },
 { value: "node", label: "Node" },
 { value: "go", label: "Go" },
 ]}
 value={snippetLang}
 onChange={setSnippetLang}
 size="sm"
 className="w-full sm:w-auto"
 />
    <pre className="bg-surface-2 border border-border/50 rounded-[10px] p-4 text-xs text-text-main font-mono overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
      {showSnippetModal && generateSnippet(snippetLang, showSnippetModal.key, typeof window !== "undefined" ? window.location.origin : "")}
    </pre>
    <Button
      onClick={() => {
        if (showSnippetModal) {
          const text = generateSnippet(snippetLang, showSnippetModal.key, typeof window !== "undefined" ? window.location.origin : "");
          navigator.clipboard.writeText(text);
        }
      }}
      icon="content_copy"
      fullWidth
    >
      Copy to Clipboard
    </Button>
  </div>
</Modal>


{/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />

      {showBulkEdit && (
        <BulkEditKeys
          selectedCount={selectedKeyIds.size}
          onApply={handleBulkEditApply}
          onClose={() => setShowBulkEdit(false)}
        />
      )}
    </div>
  );
}

