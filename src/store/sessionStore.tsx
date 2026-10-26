"use client";

import { create } from "zustand";

/** A session's permission map, as returned by GET /api/auth/status. */
export type SessionPermissions = Record<string, unknown> | null;

/** The shape of the /api/auth/status payload the store accepts. */
export interface SessionPayload {
  role?: string | null;
  permissions?: SessionPermissions;
  homePath?: string | null;
  displayName?: string | null;
  loginMethod?: string | null;
}

export interface SessionState {
  role: string | null;
  permissions: SessionPermissions;
  homePath: string | null;
  displayName: string;
  loginMethod: string;
  loaded: boolean;
  setSession: (data: SessionPayload | null) => void;
  clearSession: () => void;
}

/**
 * Who is signed in, once.
 *
 * Sidebar, HeaderMenu and the theme store all needed the same answer, and each
 * was fetching /api/auth/status on its own. The role decides what a session may
 * open (and whether it may change the site-wide theme), so it is cached here and
 * every consumer reads the same value.
 */
export const useSessionStore = create<SessionState>((set) => ({
  role: null,
  permissions: null,
  homePath: null,
  displayName: "",
  loginMethod: "",
  loaded: false,

  setSession: (data) =>
    set({
      role: data?.role || null,
      permissions: data?.permissions || null,
      homePath: data?.homePath || null,
      displayName: data?.displayName || "",
      loginMethod: data?.loginMethod || "",
      loaded: true,
    }),

  clearSession: () =>
    set({
      role: null,
      permissions: null,
      homePath: null,
      displayName: "",
      loginMethod: "",
      loaded: false,
    }),
}));

export default useSessionStore;
