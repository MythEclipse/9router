"use client";

import { create } from "zustand";
import { CLIENT_STORE_TTL_MS } from "@/shared/constants/config";

/** A provider connection row as served by GET /api/providers. */
export interface ProviderConnection {
  _id?: string;
  id?: string;
  provider?: string;
  name?: string;
  email?: string;
  authType?: string;
  isActive?: boolean;
  priority?: number;
  [key: string]: unknown;
}

export interface ProviderStoreState {
  providers: ProviderConnection[];
  loading: boolean;
  error: string | null;
  lastFetched: number;
  setProviders: (providers: ProviderConnection[]) => void;
  addProvider: (provider: ProviderConnection) => void;
  updateProvider: (id: string, updates: Partial<ProviderConnection>) => void;
  removeProvider: (id: string) => void;
  invalidate: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  fetchProviders: (options?: { force?: boolean }) => Promise<void>;
}

const useProviderStore = create<ProviderStoreState>((set, get) => ({
  providers: [],
  loading: false,
  error: null,
  lastFetched: 0,

  setProviders: (providers) => set({ providers, lastFetched: Date.now() }),

  addProvider: (provider) =>
    set((state) => ({ providers: [provider, ...state.providers] })),

  updateProvider: (id, updates) =>
    set((state) => ({
      providers: state.providers.map((p) =>
        p._id === id ? { ...p, ...updates } : p
      ),
    })),

  removeProvider: (id) =>
    set((state) => ({
      providers: state.providers.filter((p) => p._id !== id),
    })),

  invalidate: () => set({ lastFetched: 0 }),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),

  // Skips network when cache is fresh (< CLIENT_STORE_TTL_MS). Pass {force:true} to override.
  fetchProviders: async ({ force = false } = {}) => {
    const { lastFetched, providers } = get();
    if (!force && providers.length > 0 && Date.now() - lastFetched < CLIENT_STORE_TTL_MS) return;
    set({ loading: true, error: null });
    try {
      const response = await fetch("/api/providers");
      const data = (await response.json()) as {
        connections?: ProviderConnection[];
        providers?: ProviderConnection[];
        error?: string;
      };
      if (response.ok) {
        set({ providers: data.connections || data.providers || [], loading: false, lastFetched: Date.now() });
      } else {
        set({ error: data.error, loading: false });
      }
    } catch (error) {
      set({ error: "Failed to fetch providers", loading: false });
    }
  },
}));

export default useProviderStore;

