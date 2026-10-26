"use client";

import { useSyncExternalStore } from "react";
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";

/**
 * The active locale, read from the cookie that the locale API writes.
 *
 * Reading a cookie is a snapshot of external state, not something React should
 * be told about with setState from inside an effect: the value already exists
 * when the component renders, it just lives outside React. useSyncExternalStore
 * is the tool for that shape - the server render falls back to "en", the client
 * render reads the cookie, and the switcher announces changes so every reader
 * re-reads in the same tick.
 */
export const LOCALE_CHANGED_EVENT = "9router:locale-changed";

const SERVER_LOCALE = "en";

export function readLocaleCookie() {
  if (typeof document === "undefined") return SERVER_LOCALE;
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : SERVER_LOCALE;
  return normalizeLocale(value);
}

/**
 * Tell every locale reader that the cookie changed.
 *
 * A plain event rather than a module-level cache: the cookie is the single
 * source of truth, so there is no second copy that could go stale.
 */
export function notifyLocaleChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(LOCALE_CHANGED_EVENT));
}

function subscribe(onChange) {
  window.addEventListener(LOCALE_CHANGED_EVENT, onChange);
  return () => window.removeEventListener(LOCALE_CHANGED_EVENT, onChange);
}

const getServerSnapshot = () => SERVER_LOCALE;

export function useLocale() {
  return useSyncExternalStore(subscribe, readLocaleCookie, getServerSnapshot);
}
