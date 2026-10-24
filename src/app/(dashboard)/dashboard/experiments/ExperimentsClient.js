"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Toggle, PageShell } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

export default function ExperimentsClient() {
  const [hideError, setHideError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const addNotification = useNotificationStore((state) => state.addNotification);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setHideError(Boolean(data.hideError));
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleToggleHideError = async (checked) => {
    setSaving(true);
    setHideError(checked);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hideError: checked }),
      });
      if (!res.ok) {
        throw new Error("Failed to update setting");
      }
      addNotification({
        type: "success",
        title: "Saved",
        message: `Hide Error fitur telah ${checked ? "diaktifkan" : "dinonaktifkan"}.`,
      });
    } catch (err) {
      setHideError(!checked);
      addNotification({
        type: "error",
        title: "Error",
        message: err.message || "Gagal menyimpan pengaturan.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell width="full" className="min-w-0">
      <div className="flex flex-col gap-4 max-w-4xl">
        <div>
          <h1 className="text-xl font-bold text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-[24px] text-amber-500">science</span>
            Experiment Features
          </h1>
          <p className="text-xs text-text-muted mt-1">
            Fitur eksperimental dan perlindungan tingkat lanjut untuk 9Router.
          </p>
        </div>

        <Card padding="md" className="flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/40 pb-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-amber-500/10 text-amber-500 shrink-0 mt-0.5">
                <span className="material-symbols-outlined text-[22px]">visibility_off</span>
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-text-main flex items-center gap-2">
                  Hide Error
                  <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
                    Experimental
                  </span>
                </span>
                <p className="text-xs text-text-muted mt-1 leading-relaxed">
                  Mengubah semua pesan error apapun (misalnya callback gagal dari provider atau upstream filter)
                  menjadi:{" "}
                  <code className="text-rose-600 dark:text-rose-400 font-mono font-medium bg-black/5 dark:bg-white/5 px-1 py-0.5 rounded">
                    &quot;There is an error but this error is hidden, try checking your error log.&quot;
                  </code>
                  . Dengan begitu, klien atau pengguna luar tidak dapat melihat rincian error sensitif, sementara error
                  aslinya tetap tersimpan rapi dan dapat dibaca di menu <strong>Error Log</strong>.
                </p>
              </div>
            </div>
            <div className="shrink-0 flex items-center self-end sm:self-center">
              <Toggle
                checked={hideError}
                disabled={loading || saving}
                onChange={handleToggleHideError}
              />
            </div>
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
