"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, PageShell } from "@/shared/components";

export default function ErrorLogClient() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState(null);
  const [selectedLog, setSelectedLog] = useState(null);
  const [filter, setFilter] = useState("");

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch("/api/error-logs", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch (err) {
      console.error("Failed to load error logs:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  const handleClear = async () => {
    if (!window.confirm("Hapus semua error log?")) return;
    try {
      const res = await fetch("/api/error-logs", { method: "DELETE" });
      if (res.ok) setLogs([]);
    } catch (err) {
      console.error("Failed to clear error logs:", err);
    }
  };

  const copyText = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const copyAll = () => {
    const formatted = logs
      .map(
        (l) =>
          `[${l.timestamp}] [${l.statusCode}] ${l.provider || "gateway"}/${l.model || "none"}: ${l.errorMessage}${
            l.stack ? `\nStack:\n${l.stack}` : ""
          }`
      )
      .join("\n\n---\n\n");
    copyText(formatted, "all");
  };

  const filteredLogs = logs.filter((l) => {
    if (!filter) return true;
    const term = filter.toLowerCase();
    return (
      (l.errorMessage || "").toLowerCase().includes(term) ||
      (l.provider || "").toLowerCase().includes(term) ||
      (l.model || "").toLowerCase().includes(term) ||
      String(l.statusCode || "").includes(term)
    );
  });

  return (
    <PageShell width="full" className="min-w-0">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3 pb-3 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-rose-500">
              error
            </span>
            <span className="text-sm font-semibold text-text-main">Error Log</span>
            <span className="text-xs text-text-muted">({logs.length} logged)</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Filter errors..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="text-xs px-2.5 py-1 rounded-lg border border-border bg-surface text-text-main placeholder-text-muted/60 focus:outline-none focus:border-primary/50"
            />
            {logs.length > 0 && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  icon={copiedId === "all" ? "check" : "content_copy"}
                  onClick={copyAll}
                >
                  {copiedId === "all" ? "Copied All" : "Copy All"}
                </Button>
                <Button size="sm" variant="danger" icon="delete" onClick={handleClear}>
                  Clear
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" icon="refresh" onClick={fetchLogs} />
          </div>
        </div>

        <div className="divide-y divide-border/40 max-h-[calc(100dvh-220px)] overflow-y-auto">
          {loading ? (
            <div className="py-12 text-center text-text-muted text-xs">Memuat error log...</div>
          ) : filteredLogs.length === 0 ? (
            <div className="py-12 text-center text-text-muted text-xs">
              <span className="material-symbols-outlined text-3xl mb-1 text-emerald-500 block">
                check_circle
              </span>
              Tidak ada error yang tercatat. Sistem berjalan normal!
            </div>
          ) : (
            filteredLogs.map((log) => {
              const isSelected = selectedLog?.id === log.id;
              return (
                <div
                  key={log.id}
                  className={`p-3 text-xs font-mono transition-colors hover:bg-surface-2/40 cursor-pointer ${
                    isSelected ? "bg-surface-2/70" : ""
                  }`}
                  onClick={() => setSelectedLog(isSelected ? null : log)}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-500 text-[10px] font-bold border border-rose-500/20">
                        {log.statusCode || 500}
                      </span>
                      <span className="text-text-muted text-[11px]">{log.timestamp}</span>
                      {(log.provider || log.model) && (
                        <span className="text-primary font-medium text-[11px]">
                          {log.provider ? `${log.provider}/` : ""}
                          {log.model || ""}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          copyText(
                            `[${log.timestamp}] [${log.statusCode}] ${log.provider}/${log.model}: ${log.errorMessage}${
                              log.stack ? `\n${log.stack}` : ""
                            }`,
                            log.id
                          );
                        }}
                        className="p-1 text-text-muted hover:text-primary transition-colors"
                        title="Copy error"
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {copiedId === log.id ? "check" : "content_copy"}
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="mt-1 text-rose-600 dark:text-rose-400 font-sans font-medium break-words text-[13px]">
                    {log.errorMessage}
                  </div>

                  {isSelected && log.stack && (
                    <div className="mt-2.5 p-2.5 rounded bg-black/80 text-white font-mono text-[11px] overflow-x-auto whitespace-pre-wrap">
                      <div className="text-[10px] text-text-muted mb-1 uppercase tracking-wider font-sans">
                        Stack Trace:
                      </div>
                      {log.stack}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </Card>
    </PageShell>
  );
}
