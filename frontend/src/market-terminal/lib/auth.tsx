import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { open } from "@tauri-apps/api/shell";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./platform";
import { apiFetch } from "./api";

const SESSION_KEY = "dailyiq-terminal-session";
const DAILYIQ_URL = import.meta.env.VITE_DAILYIQ_URL ?? "https://dailyiq.me";

export interface DailyIQSession {
  api_key: string;
  user_id: string;
  role?: string;
  user: {
    email: string;
    user_metadata: { full_name?: string };
  };
}

interface AuthContextValue {
  session: DailyIQSession | null;
  loading: boolean;
  authError: string | null;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  setSessionFromLogin: (data: { api_key: string; user_id: string; email: string; name: string }) => void;
}

function readCachedSession(): DailyIQSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.api_key && parsed?.user?.email) return parsed as DailyIQSession;
  } catch { /* corrupted */ }
  return null;
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  loading: false,
  authError: null,
  signInWithGoogle: async () => {},
  signOut: async () => {},
  setSessionFromLogin: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<DailyIQSession | null>(readCachedSession);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const signOut = useCallback(async () => {
    window.localStorage.removeItem(SESSION_KEY);
    setSession(null);
  }, []);

  const setSessionFromLogin = useCallback((data: { api_key: string; user_id: string; email: string; name: string }) => {
    const s = saveSession(data);
    setSession(s);
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);

    if (!isTauriRuntime()) {
      setAuthError("Google sign-in is only available in the desktop app.");
      return;
    }

    let port: number;
    try {
      port = await invoke<number>("start_oauth_server");
    } catch {
      port = 17284;
    }

    // Fetch the Google OAuth URL from DailyIQ backend
    let authUrl: string;
    try {
      const res = await apiFetch(`${DAILYIQ_URL}/api-proxy/auth/terminal-google-url`);
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.detail || "Failed to get OAuth URL");
      // Replace the redirect_uri port in case it differs
      authUrl = data.url.replace("localhost:17284", `localhost:${port}`);
    } catch (e) {
      setAuthError(`Unable to start Google sign-in: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    await open(authUrl);
  }, []);

  useEffect(() => {
    let handled = false;

    const handleCode = async (code: string) => {
      if (handled) return;
      handled = true;
      setLoading(true);
      try {
        const res = await apiFetch(`${DAILYIQ_URL}/api-proxy/auth/terminal-google-exchange`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const data = await res.json();
        console.log("[auth] exchange response", res.status, data);
        if (!res.ok) {
          setAuthError(data?.detail || `Google sign-in failed (${res.status}).`);
          handled = false;
          return;
        }
        if (!data?.api_key || !data?.email) {
          console.error("[auth] exchange response missing api_key/email:", data);
          setAuthError("Sign-in error: unexpected response from server.");
          handled = false;
          return;
        }
        setSessionFromLogin(data);
      } catch (e) {
        console.error("[auth] exchange fetch failed:", e);
        setAuthError(`Unable to complete Google sign-in: ${e instanceof Error ? e.message : String(e)}`);
        handled = false;
      } finally {
        setLoading(false);
      }
    };

    // Primary: DOM CustomEvent injected by Rust via window.eval()
    const onDomEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ code: string }>).detail;
      if (detail?.code) handleCode(detail.code);
    };
    window.addEventListener("oauth-code", onDomEvent);

    // Fallback: Tauri event system
    const unlisten = isTauriRuntime()
      ? listen<{ code: string }>("oauth-code", (event) => {
          if (event.payload?.code) handleCode(event.payload.code);
        })
      : Promise.resolve(() => {});

    return () => {
      window.removeEventListener("oauth-code", onDomEvent);
      unlisten.then((fn) => fn());
    };
  }, [setSessionFromLogin]);

  return (
    <AuthContext.Provider value={{ session, loading, authError, signInWithGoogle, signOut, setSessionFromLogin }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export function saveSession(data: { api_key: string; user_id: string; email: string; name: string; role?: string }): DailyIQSession {
  const session: DailyIQSession = {
    api_key: data.api_key,
    user_id: data.user_id,
    role: data.role,
    user: {
      email: data.email,
      user_metadata: { full_name: data.name },
    },
  };
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}
