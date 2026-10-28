import { loadRuntimeDep } from "./lazyRuntime.ts";

const OPENCODE_CIPHER_LIST = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");
const DEFAULT_TIMEOUT_MS = 120_000;

type WreqResponse = {
  status: number;
  statusText?: string;
  headers?: Headers;
  body?: BodyInit | null;
};

type WreqSession = {
  fetch: (url: string | URL, options: Record<string, unknown>) => Promise<WreqResponse>;
  close?: () => void | Promise<void>;
};

type WreqModule = {
  createSession: (options: { emulation: { tlsOptions: { cipherList: string } } }) => WreqSession;
};

let sessionPromise: Promise<WreqSession> | null = null;

export class OpencodeTlsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpencodeTlsUnavailableError";
  }
}

async function loadSession(): Promise<WreqSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const wreq = await loadRuntimeDep("wreq-js") as WreqModule;
      if (typeof wreq.createSession !== "function") {
        throw new Error("wreq-js runtime is missing createSession");
      }
      return wreq.createSession({
        emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
      });
    })().catch((error: unknown) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

export function resetOpencodeTlsSession(): void {
  const pending = sessionPromise;
  sessionPromise = null;
  pending?.then((session) => session.close?.()).catch(() => {});
}

export async function opencodeTlsFetch(
  url: string | URL,
  init: RequestInit = {},
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<Response> {
  let session: WreqSession;
  try {
    session = await loadSession();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    throw new OpencodeTlsUnavailableError(
      `wreq-js unavailable (${reason}); install it to use OpenCode's TLS-compatible transport`
    );
  }

  const options: Record<string, unknown> = {
    method: init.method || "GET",
    headers: init.headers,
    redirect: "follow",
    timeout: timeoutMs,
  };
  if (init.body !== undefined) options.body = init.body;
  if (signal) options.signal = signal;

  const response = await session.fetch(url, options);
  const headers = new Headers();
  response.headers?.forEach?.((value, key) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText || "",
    headers,
  });
}

export const __test__ = { OPENCODE_CIPHER_LIST };
