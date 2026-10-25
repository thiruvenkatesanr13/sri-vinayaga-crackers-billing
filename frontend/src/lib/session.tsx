import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "./api";
import type { Bootstrap, Category, Location, Me, Product, Settings } from "./types";
import { useToast } from "../components/ui";

const COUNTER_KEY = "svc.counter";
const LOCK_KEY = "svc.locked";
const FADE_MS = 450; // same as --dur-lock

/** After logout the screen stays dark until someone taps; kept for this browser tab only. */
export const isLocked = () => window.sessionStorage.getItem(LOCK_KEY) === "1";
export const unlock = () => window.sessionStorage.removeItem(LOCK_KEY);

export function useBootstrap() {
  return useQuery({ queryKey: ["bootstrap"], queryFn: () => api.get<Bootstrap>("/api/bootstrap"), staleTime: 60_000 });
}

interface Session {
  boot: Bootstrap;
  me: Me;
  isOwner: boolean;
  counterId: number | null;
  counterName: string | null;
  setCounterId: (id: number | null) => void;
  logout: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ boot, children }: { boot: Bootstrap; children: ReactNode }) {
  const client = useQueryClient();
  const notify = useToast();
  const [leaving, setLeaving] = useState(false);
  const busy = useRef(false);
  const [stored, setStored] = useState<number | null>(() => {
    const raw = window.localStorage.getItem(COUNTER_KEY);
    return raw ? Number(raw) : null;
  });
  const counter = boot.counters.find((c) => c.id === stored) ?? null;

  const setCounterId = useCallback((id: number | null) => {
    if (id === null) window.localStorage.removeItem(COUNTER_KEY);
    else window.localStorage.setItem(COUNTER_KEY, String(id));
    setStored(id);
  }, []);

  /** The screen fades to black, the server forgets the login, and the lock screen takes over. */
  const logout = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLeaving(true);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const faded = new Promise((resolve) => window.setTimeout(resolve, reduce ? 0 : FADE_MS));
    try {
      await api.post("/api/auth/logout");
      const fresh = await api.get<Bootstrap>("/api/bootstrap");
      await faded;
      window.sessionStorage.setItem(LOCK_KEY, "1");
      await client.cancelQueries();
      client.setQueryData(["bootstrap"], fresh);
    } catch (error) {
      // Still logged in: never show the lock screen while the server keeps the login.
      busy.current = false;
      setLeaving(false);
      notify(`Could not log out: ${errorText(error)}`, "bad");
    }
  }, [client, notify]);

  const value = useMemo<Session>(
    () => ({
      boot,
      me: boot.me as Me,
      isOwner: !!boot.me?.is_owner,
      counterId: counter?.id ?? null,
      counterName: counter?.name ?? null,
      setCounterId,
      logout,
    }),
    [boot, counter, setCounterId, logout],
  );
  return (
    <SessionContext.Provider value={value}>
      {children}
      {leaving ? <div className="logout-veil" aria-hidden /> : null}
    </SessionContext.Provider>
  );
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession outside SessionProvider");
  return session;
}

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings"), staleTime: 30_000 });
}

export function useProducts() {
  return useQuery({
    queryKey: ["products"],
    queryFn: () => api.get<Product[]>("/api/products"),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

export function useCategories() {
  return useQuery({ queryKey: ["categories"], queryFn: () => api.get<Category[]>("/api/categories"), staleTime: 300_000 });
}

export function useLocations() {
  return useQuery({ queryKey: ["locations"], queryFn: () => api.get<Location[]>("/api/locations"), staleTime: 300_000 });
}
