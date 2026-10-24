"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Drawer from "@/shared/components/Drawer";
import Pagination from "@/shared/components/Pagination";
import { cn } from "@/shared/utils/cn";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";
import {
  getCachedTokens,
  getCacheCreationTokens,
  getInputTokens,
  getOutputTokens,
} from "@/lib/tokenDisplay";

let providerNameCache = null;
let providerNodesCache = null;

// A payload the API withheld on purpose carries {withheld:true}. Detect it so the
// UI shows an explanation instead of printing the marker as if it were content.
function isWithheld(value) {
  return Boolean(value && typeof value === "object" && value.withheld === true);
}

// Pretty-printing multi-megabyte JSON on render blocks the main thread, so payload
// bodies above this size are collapsed behind an explicit expand.
const BIG_PAYLOAD_CHARS = 60000;

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// JSON.stringify throws on circular / BigInt values and returns undefined for
// functions; a payload viewer must degrade to something rather than blank the tab.
function safeStringify(value) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch (err) {
    return `[unserializable payload: ${err?.message || err}]`;
  }
}

function LargePayload({ value }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? value : value.slice(0, 8000);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <span className="font-mono">{formatBytes(value.length)}</span>
        <Button variant="outline" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Collapse" : "Expand full payload"}
        </Button>
        <span>Showing first 8 KB until expanded.</span>
      </div>
      <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5 sm:p-4">
        {shown}
        {!expanded && value.length > shown.length
          ? "\n… truncated in view (expand to see the rest)"
          : ""}
      </pre>
    </div>
  );
}

function WithheldNotice({ value }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100 sm:p-4">
      <div className="mb-1 flex items-center gap-2 font-semibold">
        <span className="material-symbols-outlined text-[16px]">visibility_off</span>
        Payload withheld
      </div>
      <p className="opacity-90">
        {value?.field ? <code className="font-mono">{value.field}</code> : "This field"} was not
        returned by the API{value?.bytes ? ` (${value.bytes} bytes stored)` : ""}.
      </p>
      <p className="mt-1 opacity-90">
        {value?.hint || "Enable payloads in Settings → Observability to view it."}
      </p>
    </div>
  );
}

function PayloadSection({ title, value, icon, defaultOpen = false }) {
  const withheld = isWithheld(value);
  if (withheld) {
    return (
      <CollapsibleSection title={`${title} — withheld`} defaultOpen={defaultOpen} icon={icon}>
        <WithheldNotice value={value} />
      </CollapsibleSection>
    );
  }

  // A translated provider request can be ~1 MB (long conversations, tool schemas).
  // Pretty-printing that on every open freezes the tab, so past a threshold show
  // the size and let the operator expand deliberately.
  const raw = typeof value === "string" ? value : safeStringify(value);
  const big = raw.length > BIG_PAYLOAD_CHARS;

  return (
    <CollapsibleSection
      title={big ? `${title} — ${formatBytes(raw.length)}` : title}
      defaultOpen={defaultOpen}
      icon={icon}
    >
      {big ? (
        <LargePayload value={raw} />
      ) : (
        <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5 sm:p-4">
          {raw}
        </pre>
      )}
    </CollapsibleSection>
  );
}

async function fetchProviderNames() {
  if (providerNameCache && providerNodesCache) {
    return { providerNameCache, providerNodesCache };
  }

  const nodesRes = await fetch("/api/provider-nodes");
  const nodesData = await nodesRes.json();
  const nodes = nodesData.nodes || [];
  providerNodesCache = {};

  for (const node of nodes) {
    providerNodesCache[node.id] = node.name;
  }

  providerNameCache = {
    ...AI_PROVIDERS,
    ...providerNodesCache,
  };

  return { providerNameCache, providerNodesCache };
}

function getProviderName(providerId, cache) {
  if (!providerId) return providerId;
  if (!cache) return providerId;

  const cached = cache[providerId];

  if (typeof cached === "string") {
    return cached;
  }

  if (cached?.name) {
    return cached.name;
  }

  const providerConfig = getProviderByAlias(providerId) || AI_PROVIDERS[providerId];
  return providerConfig?.name || providerId;
}

function CollapsibleSection({ title, children, defaultOpen = false, icon = null }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-black/5 dark:border-white/5 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
      >
        <div className="flex items-center gap-2">
          {icon && (
            <span className="material-symbols-outlined text-[18px] text-text-muted">{icon}</span>
          )}
          <span className="font-semibold text-sm text-text-main">{title}</span>
        </div>
        <span
          className={cn(
            "material-symbols-outlined text-[20px] text-text-muted transition-transform duration-200",
            isOpen ? "rotate-90" : "",
          )}
        >
          chevron_right
        </span>
      </button>

      {isOpen && <div className="p-4 border-t border-black/5 dark:border-white/5">{children}</div>}
    </div>
  );
}

export default function RequestDetailsTab() {
  const [details, setDetails] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState(null);
  // Set when the per-record full payload could not be loaded (key session), so
  // the drawer can say why instead of showing a redacted body silently.
  const [fullBodyError, setFullBodyError] = useState("");
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [providers, setProviders] = useState([]);
  const [providerNameCache, setProviderNameCache] = useState(null);
  const [filters, setFilters] = useState({
    provider: "",
    startDate: "",
    endDate: "",
  });

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/usage/providers");
      const data = await res.json();
      setProviders(data.providers || []);

      const cache = await fetchProviderNames();
      setProviderNameCache(cache.providerNameCache);
    } catch (error) {
      console.error("Failed to fetch providers:", error);
    }
  }, []);

  // Guards against out-of-order responses: paging quickly issues overlapping
  // requests, and a slower earlier one would otherwise overwrite the newer page.
  const requestSeq = useRef(0);

  const fetchDetails = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString(),
      });
      if (filters.provider) params.append("provider", filters.provider);
      if (filters.startDate) params.append("startDate", filters.startDate);
      if (filters.endDate) params.append("endDate", filters.endDate);

      const res = await fetch(`/api/usage/request-details?${params}`);
      const data = await res.json();
      if (seq !== requestSeq.current) return; // a newer request already answered

      setDetails(data.details || []);
      setPagination((prev) => ({ ...prev, ...data.pagination }));
    } catch (error) {
      if (seq !== requestSeq.current) return;
      console.error("Failed to fetch request details:", error);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [pagination.page, pagination.pageSize, filters]);

  // Data fetching on mount/pager change is the intended effect here: these callbacks
  // are async, so setState lands in a promise continuation, not synchronously in the
  // effect body — the rule cannot tell those apart.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchProviders();
  }, [fetchProviders]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchDetails();
  }, [fetchDetails]);

  const handleViewDetail = async (detail) => {
    setSelectedDetail(detail);
    setFullBodyError("");
    setIsDrawerOpen(true);

    // The listing redacts conversation bodies; the full payload comes from an
    // admin-only per-record endpoint and is merged over the row once it lands.
    const id = detail?.id;
    if (!id) return;
    try {
      const res = await fetch(`/api/usage/request-details/${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFullBodyError(data.error || "Full request body is not available for this session");
        return;
      }
      if (data.detail) {
        setSelectedDetail((prev) => (prev && prev.id === id ? { ...prev, ...data.detail } : prev));
      }
    } catch (err) {
      setFullBodyError(err.message || "Failed to load the full request body");
    }
  };

  const handlePageChange = (newPage) => {
    setPagination((prev) => ({ ...prev, page: newPage }));
  };

  const handlePageSizeChange = (newPageSize) => {
    setPagination((prev) => ({ ...prev, pageSize: newPageSize, page: 1 }));
  };

  // A filter change on page 3 asks for page 3 of a narrower result set, which is
  // usually empty — the operator then believes the filter matched nothing. Reset to
  // the first page whenever the query changes.
  const updateFilters = (patch) => {
    setFilters({ ...filters, ...patch });
    setPagination((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
  };

  const handleClearFilters = () => {
    setFilters({ provider: "", startDate: "", endDate: "" });
    setPagination((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card padding="md">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="provider-filter" className="text-sm font-medium text-text-main">
              Provider
            </label>
            <select
              id="provider-filter"
              value={filters.provider}
              onChange={(e) => updateFilters({ provider: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20",
                "w-full min-w-0 cursor-pointer",
              )}
              style={{ colorScheme: "auto" }}
            >
              <option value="">All Providers</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="start-date-filter" className="text-sm font-medium text-text-main">
              Start Date
            </label>
            <input
              id="start-date-filter"
              type="datetime-local"
              value={filters.startDate}
              onChange={(e) => updateFilters({ startDate: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20",
              )}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="end-date-filter" className="text-sm font-medium text-text-main">
              End Date
            </label>
            <input
              id="end-date-filter"
              type="datetime-local"
              value={filters.endDate}
              onChange={(e) => updateFilters({ endDate: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20",
              )}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-2 sm:col-span-2 lg:col-span-1">
            <span
              className="hidden text-sm font-medium text-text-main opacity-0 lg:block"
              aria-hidden="true"
            >
              Clear
            </span>
            <Button
              variant="ghost"
              onClick={handleClearFilters}
              disabled={!filters.provider && !filters.startDate && !filters.endDate}
              className="w-full"
            >
              Clear Filters
            </Button>
          </div>
        </div>
      </Card>

      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px]">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/5">
                <th className="text-left p-4 text-sm font-semibold text-text-main">Timestamp</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Model</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Provider</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">
                  Input Tokens
                </th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Cached</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">
                  Cache Creation
                </th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">
                  Output Tokens
                </th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Latency</th>
                <th className="text-center p-4 text-sm font-semibold text-text-main">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="9" className="p-8 text-center text-text-muted">
                    <div className="flex items-center justify-center gap-2">
                      <span className="material-symbols-outlined animate-spin text-[20px]">
                        progress_activity
                      </span>
                      Loading...
                    </div>
                  </td>
                </tr>
              ) : details.length === 0 ? (
                <tr>
                  <td colSpan="9" className="p-8 text-center text-text-muted">
                    No request details found
                  </td>
                </tr>
              ) : (
                details.map((detail, index) => (
                  <tr
                    key={`${detail.id}-${index}`}
                    className="border-b border-black/5 dark:border-white/5 last:border-b-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="whitespace-nowrap p-4 text-sm text-text-main">
                      {new Date(detail.timestamp).toLocaleString()}
                    </td>
                    {detail.resolvedModel && detail.resolvedModel !== detail.model ? (
                    <td className="max-w-[260px] p-4 font-mono text-sm">
                      <div className="truncate text-text-main" title={detail.model}>{detail.model}</div>
                      <div className="truncate text-text-muted text-xs" title={`${detail.provider}/${detail.resolvedModel}`}>→ {detail.provider}/{detail.resolvedModel}</div>
                    </td>
                    ) : (
                    <td className="max-w-[260px] truncate p-4 font-mono text-sm text-text-main">
                      {detail.model}
                    </td>
                    )}
                    <td className="max-w-[180px] truncate p-4 text-sm text-text-main">
                      <span className="font-medium">
                        {getProviderName(detail.provider, providerNameCache)}
                      </span>
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {getInputTokens(detail.tokens).toLocaleString()}
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {getCachedTokens(detail.tokens) > 0 ? getCachedTokens(detail.tokens).toLocaleString() : "-"}
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {getCacheCreationTokens(detail.tokens) > 0 ? getCacheCreationTokens(detail.tokens).toLocaleString() : "-"}
                    </td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">
                      {getOutputTokens(detail.tokens).toLocaleString()}
                    </td>
                    <td className="p-4 text-sm text-text-muted">
                      <div className="flex flex-col gap-0.5">
                        <div>
                          TTFT: <span className="font-mono">{detail.latency?.ttft || 0}ms</span>
                        </div>
                        <div>
                          Total: <span className="font-mono">{detail.latency?.total || 0}ms</span>
                        </div>
                      </div>
                    </td>
                    <td className="p-4 text-center">
                      <Button variant="outline" size="sm" onClick={() => handleViewDetail(detail)}>
                        Detail
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && details.length > 0 && (
          <div className="border-t border-black/5 dark:border-white/5">
            <Pagination
              currentPage={pagination.page}
              pageSize={pagination.pageSize}
              totalItems={pagination.totalItems}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          </div>
        )}
      </Card>

      <Drawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        title="Request Details"
        width="lg"
      >
        {selectedDetail && (
          <div className="space-y-6">
            {fullBodyError && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                <span className="material-symbols-outlined text-[16px]">info</span>
                <span>{fullBodyError}</span>
              </div>
            )}
            <div className="grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <div>
                <span className="text-text-muted">ID:</span>{" "}
                <span className="break-all font-mono text-text-main">{selectedDetail.id}</span>
              </div>
              <div>
                <span className="text-text-muted">Timestamp:</span>{" "}
                <span className="text-text-main">
                  {new Date(selectedDetail.timestamp).toLocaleString()}
                </span>
              </div>
              <div>
                <span className="text-text-muted">Provider:</span>{" "}
                <span className="text-text-main font-medium">
                  {getProviderName(selectedDetail.provider, providerNameCache)}
                </span>
              </div>
              <div>
                <span className="text-text-muted">Model:</span>{" "}
                {selectedDetail.resolvedModel && selectedDetail.resolvedModel !== selectedDetail.model ? (
                  <span className="text-text-main font-mono" title={selectedDetail.model}>{selectedDetail.model}{" "}<span className="text-text-muted text-xs" title={`${selectedDetail.provider}/${selectedDetail.resolvedModel}`}>→ {selectedDetail.provider}/{selectedDetail.resolvedModel}</span></span>
                ) : (
                  <span className="text-text-main font-mono">{selectedDetail.model}</span>
                )}
              </div>
              <div>
                <span className="text-text-muted">Status:</span>{" "}
                <span
                  className={cn(
                    "font-medium",
                    selectedDetail.status === "success" ? "text-green-600" : "text-red-600",
                  )}
                >
                  {selectedDetail.status}
                </span>
              </div>
              <div>
                <span className="text-text-muted">Latency:</span>{" "}
                <span className="text-text-main font-mono">
                  TTFT {selectedDetail.latency?.ttft || 0}ms / Total{" "}
                  {selectedDetail.latency?.total || 0}ms
                </span>
              </div>
              <div>
                <span className="text-text-muted">Input Tokens:</span>{" "}
                <span className="text-text-main font-mono">
                  {getInputTokens(selectedDetail.tokens).toLocaleString()}
                </span>
              </div>
              {getCachedTokens(selectedDetail.tokens) > 0 && (
                <div>
                  <span className="text-text-muted">Cached Tokens:</span>{" "}
                  <span className="text-text-main font-mono">
                    {getCachedTokens(selectedDetail.tokens).toLocaleString()}
                  </span>
                </div>
              )}
              {getCacheCreationTokens(selectedDetail.tokens) > 0 && (
                <div>
                  <span className="text-text-muted">Cache Creation:</span>{" "}
                  <span className="text-text-main font-mono">
                    {getCacheCreationTokens(selectedDetail.tokens).toLocaleString()}
                  </span>
                </div>
              )}
              <div>
                <span className="text-text-muted">Output Tokens:</span>{" "}
                <span className="text-text-main font-mono">
                  {getOutputTokens(selectedDetail.tokens).toLocaleString()}
                </span>
              </div>
            </div>

            {selectedDetail.pxpipe && (
              <div className="rounded-lg border border-black/5 dark:border-white/5 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-[18px] text-text-muted">
                    image
                  </span>
                  <span className="font-semibold text-sm text-text-main">PXPIPE</span>
                  <span
                    className={cn(
                      "text-xs px-2 py-0.5 rounded",
                      selectedDetail.pxpipe.applied
                        ? "bg-green-500/15 text-green-600"
                        : "bg-amber-500/15 text-amber-600",
                    )}
                  >
                    {selectedDetail.pxpipe.applied ? "Activated" : "Skipped"}
                  </span>
                </div>
                {selectedDetail.pxpipe.applied ? (
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <div>
                      <span className="text-text-muted block text-xs">Original (est.)</span>
                      <span className="font-mono">
                        {(selectedDetail.pxpipe.tokensBeforeEst || 0).toLocaleString()} tokens
                      </span>
                    </div>
                    <div>
                      <span className="text-text-muted block text-xs">Compressed (est.)</span>
                      <span className="font-mono">
                        {(selectedDetail.pxpipe.tokensAfterEst || 0).toLocaleString()} tokens
                      </span>
                    </div>
                    <div>
                      <span className="text-text-muted block text-xs">Saved</span>
                      <span className="font-mono text-green-600">
                        {selectedDetail.pxpipe.savedPct || 0}%
                      </span>
                    </div>
                    <div>
                      <span className="text-text-muted block text-xs">Images</span>
                      <span className="font-mono">
                        {selectedDetail.pxpipe.imageCount || 0} (
                        {selectedDetail.pxpipe.durationMs || 0}ms)
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-text-muted">
                    Reason: <span className="font-mono">{selectedDetail.pxpipe.reason}</span>
                    {selectedDetail.pxpipe.detail ? ` - ${selectedDetail.pxpipe.detail}` : ""}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-4">
              <PayloadSection
                title="1. Client Request (Input)"
                defaultOpen={true}
                icon="input"
                value={selectedDetail.request}
              />

              {selectedDetail.providerRequest && (
                <PayloadSection
                  title="2. Provider Request (Translated)"
                  icon="translate"
                  value={selectedDetail.providerRequest}
                />
              )}

              {selectedDetail.providerResponse && (
                <PayloadSection
                  title="3. Provider Response (Raw)"
                  icon="data_object"
                  value={selectedDetail.providerResponse}
                />
              )}

              <CollapsibleSection
                title="4. Client Response (Final)"
                defaultOpen={true}
                icon="output"
              >
                {isWithheld(selectedDetail.response) ? (
                  <WithheldNotice value={selectedDetail.response} />
                ) : (
                  <>
                    {selectedDetail.response?.thinking && (
                      <div className="mb-4">
                        <h4 className="font-semibold text-text-main mb-2 flex items-center gap-2 text-xs uppercase tracking-wide opacity-70">
                          <span className="material-symbols-outlined text-[16px]">psychology</span>
                          Thinking Process
                        </h4>
                        <pre className="max-h-[200px] max-w-full overflow-auto rounded-lg border border-amber-200 bg-amber-50 p-3 font-mono text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100 sm:p-4">
                          {selectedDetail.response.thinking}
                        </pre>
                      </div>
                    )}

                    <h4 className="font-semibold text-text-main mb-2 text-xs uppercase tracking-wide opacity-70">
                      Content
                    </h4>
                    <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5 sm:p-4">
                      {selectedDetail.response?.content || "[No content]"}
                    </pre>
                  </>
                )}
              </CollapsibleSection>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}