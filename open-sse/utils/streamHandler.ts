// Stream handler with disconnect detection - shared for all providers
import { STREAM_STALL_TIMEOUT_MS, MAX_STREAM_BYTES_PER_REQUEST } from "../config/runtimeConfig";
import { dbg, isDebugEnabled } from "./debugLog";
import { formatClockTime } from "./timeFormat";

const MAX_TOTAL_STREAM_BYTES = MAX_STREAM_BYTES_PER_REQUEST || 100 * 1024 * 1024; // 100MB default
const STALL_CHECK_INTERVAL_MS = 1000; // Check stall every second

// Get HH:MM:SS timestamp
function getTimeString() {
  return formatClockTime();
}

/** Callbacks and identity carried by a stream controller. */
export interface StreamControllerOptions {
  /** Invoked when the client goes away, with the disconnect reason. */
  onDisconnect?: (info: { reason: string; duration: number }) => void;
  onError?: (error: Error) => void;
  log?: {
    line?: (tag: string, symbol: string, message: string) => void;
    errorLine?: (tag: string, symbol: string, message: string) => void;
  };
  provider?: string;
  model?: string;
  reqTag?: string;
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({ onDisconnect, onError, log, provider, model, reqTag = "" }: StreamControllerOptions = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  // Only abnormal terminations are logged; normal completion is covered by "📊 done".
  // isError uses errorLine (always shown, ignores LOG_LEVEL) so failures survive quiet levels.
  const logStream = (symbol, status, isError = false) => {
    const duration = Date.now() - startTime;
    const emit = isError ? log?.errorLine : log?.line;
    if (emit) emit(reqTag, symbol, `${status} · ${provider}/${model} · ${duration}ms`);
    else console.log(`[${getTimeString()}] ${symbol} ${provider}/${model} · ${status} · ${duration}ms`);
  };

  return {
    signal: abortController.signal,
    startTime,
    provider: provider || "unknown",
    model: model || "unknown",

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;

      // Debug-only: Responses API has no [DONE] sentinel, so codex/droid close the
      // socket on every completed request. "📊 done" is the authoritative outcome line.
      dbg("CTRL", `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`);

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, 500);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally (no line here - "📊 done" is authoritative)
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("⚡", "ABORTED");
        return;
      }

      logStream("✗", `ERROR: ${error.message}${error.stack ? `\n    ${error.stack}` : ""}`, true);
      onError?.(error);
    },

    abort: () => abortController.abort()
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here - output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 *
 * @param {function} [onAbortTerminal] - Receives a human-readable abort
 * message and returns terminal SSE bytes to emit downstream.
 */
export function createDisconnectAwareStream(transformStream, streamController, onAbortTerminal = null) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable.getWriter();
  const providerName = streamController?.provider || "unknown";
  const modelName = streamController?.model || "unknown";
  let terminalEmitted = false;

  // Emit a synthesized terminal payload (e.g. Responses response.failed + [DONE]) once
  const emitTerminal = (controller) => {
    if (terminalEmitted || !onAbortTerminal) return;
    terminalEmitted = true;
    try {
      const bytes = onAbortTerminal();
      if (bytes) controller.enqueue(bytes);
    } catch { /* best-effort terminal */ }
  };

  return new ReadableStream({
    async pull(controller) {
      if (!streamController.isConnected()) {
        dbg("STREAM", `pull skipped | disconnected=true | provider=${providerName} | model=${modelName}`);
        emitTerminal(controller);
        controller.close();
        return;
      }

      try {
        const { done, value } = await reader.read();

        if (done) {
          dbg("STREAM", `transform reader done | provider=${providerName} | model=${modelName}`);
          streamController.handleComplete();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        const wasConnected = streamController.isConnected();
        const msg0 = error?.message || "";
        const isControllerClosed = msg0.includes("already closed") || msg0.includes("Invalid state");
        dbg("STREAM", `transform pull failed | provider=${providerName} | model=${modelName} | connected=${wasConnected} | locked=${String(msg0).includes("locked")} | reason=${msg0}`);
        if (!isControllerClosed) streamController.handleError(error);
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});

        // Treat network resets / socket hang up / abort as graceful close
        const msg = error?.message || "";
        const code = error?.code || error?.cause?.code || "";
        const isNetworkClose =
          error.name === "AbortError" ||
          msg.includes("aborted") ||
          msg.includes("socket hang up") ||
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("EPIPE") ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT" ||
          code === "EPIPE" ||
          code === "UND_ERR_SOCKET";

        // Graceful close on network/abort, or when a structured terminal is available
        // (Responses passthrough prefers response.failed + [DONE] over a raw transport error)
        try {
          if (!wasConnected || isNetworkClose || onAbortTerminal) {
            emitTerminal(controller);
            controller.close();
          } else {
            controller.error(error);
          }
        } catch (e) { /* already closed or cancelled */ }
      }
    },

    cancel(reason) {
      dbg("STREAM", `cancelled | provider=${providerName} | model=${modelName} | reason=${String(reason || "cancelled")}`);
      streamController.handleDisconnect(reason || "cancelled");
      reader.cancel();
      writer.abort();
    }
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
function buildClosedTerminalStream(onAbortTerminal = null, reason = "upstream stream closed") {
  return new ReadableStream({
    start(controller) {
      try {
        if (typeof onAbortTerminal === "function") {
          const bytes = onAbortTerminal(reason);
          if (bytes) controller.enqueue(bytes);
        }
      } catch { /* terminal emission is best-effort only */ }
      controller.close();
    }
  });
}

export function safePipeResponseBody(response, transformStream, { context = "response", onError = null } = {}) {
  const body = response?.body;
  const bodyLocked = !!body && typeof body.getReader === "function" && body.locked;

  if (!body || bodyLocked) {
    const reason = bodyLocked ? "upstream body already locked" : "upstream body missing";
    const err = new TypeError(`${context} pipe skipped: ${reason}`);
    onError?.(err);
    return buildClosedTerminalStream(null, reason);
  }

  try {
    return body.pipeThrough(transformStream);
  } catch (error) {
    onError?.(error);
    return buildClosedTerminalStream(null, error?.message || "stream pipe failed");
  }
}

/**
 * Validate and sanitize stream response metadata
 * @param {object} response - Response object
 * @returns {boolean} Whether response is valid for streaming
 */
function isValidStreamResponse(response) {
  if (!response || typeof response !== "object") return false;
  if (!response.body || typeof response.body.getReader !== "function") return false;
  if (!response.headers || typeof response.headers.get !== "function") return false;
  return true;
}

/**
 * Build a safe error message that doesn't leak sensitive information
 * @param {Error|string} error - Error or error message
 * @returns {string} Safe error message
 */
function buildSafeErrorMessage(error) {
  const msg = typeof error === "string" ? error : (error?.message || "Unknown stream error");
  // Remove any potential sensitive information (API keys, tokens, paths)
  return msg
    .replace(/(?:sk|pk)_[a-zA-Z0-9]{20,}/g, "[REDACTED]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/authorization:\s*[^\s]/gi, "authorization: [REDACTED]");
}

/**
 * Render terminal bytes for an aborted stream. `message` is the human-readable
 * reason; the return value (if any) is enqueued as the closing frame.
 */
export type AbortTerminalBuilder = (message: string) => Uint8Array | string | null | undefined;

export function pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal: AbortTerminalBuilder | null = null, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS) {
  const tag = "STREAM";

  // Validate response before processing
  if (!isValidStreamResponse(providerResponse)) {
    const reason = "invalid stream response";
    const err = new TypeError(`stream pipe skipped: ${reason}`);
    dbg(tag, `pipe skip | reason=${reason}`);
    streamController?.handleDisconnect?.(reason);
    return buildClosedTerminalStream(onAbortTerminal, reason);
  }

  const contentType = providerResponse?.headers?.get?.("content-type") || "unknown";
  const body = providerResponse?.body;
  const bodyLocked = !!body && typeof body.getReader === "function" && body.locked;

  if (bodyLocked) {
    const reason = "upstream body already locked";
    const err = new TypeError(`stream pipe skipped: ${reason} | contentType=${contentType}`);
    dbg(tag, `pipe skip | reason=${reason} | status=${providerResponse?.status || "unknown"} | contentType=${contentType}`);
    streamController?.handleDisconnect?.(reason);
    return buildClosedTerminalStream(onAbortTerminal, reason);
  }

  // Initialize tracking variables with safe defaults
  let stallTimer = null;
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  let abortMessage = "upstream connection lost";
  const t0 = Date.now();
  let streamErrored = false;

  // Clear stall timer safely
  const clearStall = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  // Arm stall timer with validation
  const armStall = () => {
    clearStall();
    if (streamErrored) return;

    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (streamErrored) return;

      abortMessage = "stream stall timeout";
      const detail = {
        phase: "upstream stall",
        stallTimeoutMs,
        chunks: chunkCount,
        totalBytes,
        sinceLastMs: Date.now() - lastChunkAt,
        status: providerResponse?.status || "unknown",
        contentType: contentType,
      };
      dbg(tag, `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`);
      streamController.handleError?.(new Error(`stream stall timeout: ${detail.chunks} chunks, ${detail.totalBytes} bytes`));
      streamController.abort?.();
      streamErrored = true;
    }, stallTimeoutMs);
  };

  // Cleanup function for all termination paths
  const cleanupStream = () => {
    clearStall();
    streamErrored = true;
  };

  // Wrap controller so every termination path clears the stall timer.
  const wrappedController = {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    handleComplete: () => {
      dbg(tag, `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`);
      cleanupStream();
      streamController.handleComplete();
    },
    handleError: (e) => {
      const safeMsg = buildSafeErrorMessage(e);
      dbg(tag, `error: ${safeMsg} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`);
      cleanupStream();
      streamController.handleError(e);
    },
    handleDisconnect: (r) => {
      dbg(tag, `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`);
      cleanupStream();
      streamController.handleDisconnect(r);
    },
    abort: () => {
      clearStall();
      streamErrored = true;
      streamController.abort();
    }
  };

  armStall();
  dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms`);

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      if (streamErrored) return; // Stop processing if stream has errored

      chunkCount++;
      const sz = chunk?.byteLength || chunk?.length || 0;

      // Check total bytes limit
      totalBytes += sz;
      if (totalBytes > MAX_TOTAL_STREAM_BYTES) {
        cleanupStream();
        abortMessage = "stream exceeded maximum size limit";
        streamController.handleError?.(new Error(`stream too large: ${totalBytes} bytes > ${MAX_TOTAL_STREAM_BYTES}`));
        streamController.abort?.();
        return;
      }

      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;

      // Log periodically for debugging
      if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
        dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`);
      }

      armStall();
      controller.enqueue(chunk);
    },
    flush() {
      dbg(tag, `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`);
      cleanupStream();
    }
  });

  let transformedBody;
  try {
    transformedBody = providerResponse.body
      .pipeThrough(upstreamTap)
      .pipeThrough(transformStream);
  } catch (error) {
    cleanupStream();
    const safeMsg = buildSafeErrorMessage(error);
    dbg(tag, `pipeThrough failed: ${safeMsg}`);
    streamController?.handleError?.(error);
    return buildClosedTerminalStream(onAbortTerminal, safeMsg);
  }

  return createDisconnectAwareStream(
    { readable: transformedBody, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
    wrappedController,
    onAbortTerminal ? () => onAbortTerminal(abortMessage) : null
  );
}

