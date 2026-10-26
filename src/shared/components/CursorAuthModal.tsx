"use client";

import { useState, useEffect } from "react";
import { Modal, Button, Input } from "@/shared/components";

/**
 * Cursor Auth Modal
 * Auto-detect and import token from Cursor IDE's local SQLite database
 */
interface CursorAuthModalProps {
  isOpen: boolean
  onSuccess?(...args: unknown[]): unknown
  onClose(...args: unknown[]): unknown
}

export default function CursorAuthModal({ isOpen, onSuccess, onClose }: CursorAuthModalProps) {
  const [accessToken, setAccessToken] = useState("");
  const [machineId, setMachineId] = useState("");
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [detect, setDetect] = useState({ status: "idle", found: false, windowsManual: false });

  // Auto-detect tokens when modal opens. The request starts from an inline
  // async function and every state update happens in its callbacks, so the
  // effect never writes state synchronously.
  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/oauth/cursor/auto-import");
        const data = await res.json();
        if (cancelled) return;

        if (data.found) {
          setAccessToken(data.accessToken);
          setMachineId(data.machineId);
          setDetect({ status: "done", found: true, windowsManual: false });
        } else if (data.windowsManual) {
          setDetect({ status: "done", found: false, windowsManual: true });
        } else {
          setError(data.error || "Could not auto-detect tokens");
          setDetect({ status: "done", found: false, windowsManual: false });
        }
      } catch {
        if (cancelled) return;
        setError("Failed to auto-detect tokens");
        setDetect({ status: "done", found: false, windowsManual: false });
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen]);

  const autoDetecting = isOpen && detect.status !== "done";
  const autoDetected = detect.found;
  const windowsManual = detect.windowsManual;

  // Retry from the Windows hint: show the spinner again, then reuse the same
  // request as the open path.
  const retryAutoDetect = async () => {
    setDetect({ status: "idle", found: false, windowsManual: false });
    try {
      const res = await fetch("/api/oauth/cursor/auto-import");
      const data = await res.json();

      if (data.found) {
        setAccessToken(data.accessToken);
        setMachineId(data.machineId);
        setDetect({ status: "done", found: true, windowsManual: false });
      } else if (data.windowsManual) {
        setDetect({ status: "done", found: false, windowsManual: true });
      } else {
        setError(data.error || "Could not auto-detect tokens");
        setDetect({ status: "done", found: false, windowsManual: false });
      }
    } catch {
      setError("Failed to auto-detect tokens");
      setDetect({ status: "done", found: false, windowsManual: false });
    }
  };

  const handleImportToken = async () => {
    if (!accessToken.trim()) {
      setError("Please enter an access token");
      return;
    }

    if (!machineId.trim()) {
      setError("Please enter a machine ID");
      return;
    }

    setImporting(true);
    setError(null);

    try {
      const res = await fetch("/api/oauth/cursor/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: accessToken.trim(),
          machineId: machineId.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Import failed");
      }

      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Connect Cursor IDE" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {/* Auto-detecting state */}
        {autoDetecting && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-primary animate-spin">
                progress_activity
              </span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Auto-detecting tokens...</h3>
            <p className="text-sm text-text-muted">
              Reading from Cursor IDE database
            </p>
          </div>
        )}

        {/* Form (shown after auto-detect completes) */}
        {!autoDetecting && (
          <>
            {/* Success message if auto-detected */}
            {autoDetected && (
              <div className="bg-green-50 dark:bg-green-900/20 p-3 rounded-lg border border-green-200 dark:border-green-800">
                <div className="flex gap-2">
                  <span className="material-symbols-outlined text-green-600 dark:text-green-400">check_circle</span>
                  <p className="text-sm text-green-800 dark:text-green-200">
                    Tokens auto-detected from Cursor IDE successfully!
                  </p>
                </div>
              </div>
            )}

            {/* Windows manual instructions */}
            {windowsManual && (
              <div className="bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg border border-amber-200 dark:border-amber-800 flex flex-col gap-2">
                <div className="flex gap-2 items-center">
                  <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">info</span>
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    Could not read Cursor database automatically.
                  </p>
                </div>
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  Make sure Cursor IDE has been opened at least once, then click <strong>Retry</strong>. If the problem persists, paste your tokens manually below.
                </p>
                <Button onClick={retryAutoDetect} variant="outline" fullWidth>
                  Retry
                </Button>
              </div>
            )}

            {/* Info message if not auto-detected */}
            {!autoDetected && !windowsManual && !error && (
              <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
                <div className="flex gap-2">
                  <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
                  <p className="text-sm text-blue-800 dark:text-blue-200">
                    Paste your Cursor tokens manually because the IDE was not detected.
                  </p>
                </div>
              </div>
            )}

            {/* Access Token Input */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Access Token <span className="text-red-500">*</span>
              </label>
              <textarea
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="Access token will be auto-filled..."
                rows={3}
                className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-background focus:outline-none focus:border-primary resize-none"
              />
            </div>

            {/* Machine ID Input */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Machine ID <span className="text-red-500">*</span>
              </label>
              <Input
                value={machineId}
                onChange={(e) => setMachineId(e.target.value)}
                placeholder="Machine ID will be auto-filled..."
                className="font-mono text-sm"
              />
            </div>

            {/* Error Display */}
            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-2">
              <Button
                onClick={handleImportToken}
                fullWidth
                disabled={importing || !accessToken.trim() || !machineId.trim()}
              >
                {importing ? "Importing..." : "Import Token"}
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

