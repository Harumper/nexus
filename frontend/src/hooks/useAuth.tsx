import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import Keycloak from "keycloak-js";
import { api } from "../services/api";
import type { AuthState, AuthConfig } from "../types";

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  loginKeycloak: () => void;
  logout: () => Promise<void>;
  loading: boolean;
  authConfig: AuthConfig | null;
}

const AuthContext = createContext<AuthContextType | null>(null);

const TOKEN_KEY = "nexus_token";
const PROVIDER_KEY = "nexus_provider";

// Module-level guard — survives React StrictMode remount
// (useRef resets on unmount/remount, unlike a module variable)
let authInitStarted = false;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    token: null,
    isAuthenticated: false,
    provider: null,
  });
  const [loading, setLoading] = useState(true);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const keycloakRef = useRef<Keycloak | null>(null);

  // 1. Load the backend auth config at startup
  useEffect(() => {
    if (authInitStarted) return;
    authInitStarted = true;

    fetch("/api/auth/config")
      .then((r) => r.json())
      .then(async (config: AuthConfig) => {
        setAuthConfig(config);

        const savedProvider = sessionStorage.getItem(PROVIDER_KEY);

        // Always prepare the Keycloak instance if configured
        // (so loginKeycloak() works even in "both" mode)
        if (config.keycloak) {
          const kc = new Keycloak({
            url: config.keycloak.url,
            realm: config.keycloak.realm,
            clientId: config.keycloak.clientId,
          });
          keycloakRef.current = kc;
        }

        // Detect an OIDC code in the URL (return from Keycloak)
        const hasOidcCode = window.location.hash.includes("code=") ||
          window.location.search.includes("code=");

        // Authenticate according to the mode
        if (hasOidcCode && config.keycloak) {
          // Return from Keycloak with a code — force processing
          await initKeycloak(config, true);
        } else if (
          config.keycloak &&
          (config.mode === "keycloak" || savedProvider === "keycloak")
        ) {
          await initKeycloak(config, false);
        } else if (config.local) {
          await restoreLocalSession();
        } else if (config.keycloak) {
          await initKeycloak(config, false);
        }

        setLoading(false);
      })
      .catch(() => {
        // If the backend is unavailable, try local
        restoreLocalSession().finally(() => setLoading(false));
      });
  }, []);

  // Init Keycloak (reuses the instance already created in keycloakRef)
  const initKeycloak = async (config: AuthConfig, forceLogin = false) => {
    if (!config.keycloak) return;

    const kc = keycloakRef.current || new Keycloak({
      url: config.keycloak.url,
      realm: config.keycloak.realm,
      clientId: config.keycloak.clientId,
    });
    keycloakRef.current = kc;

    try {
      const authenticated = await kc.init({
        onLoad: forceLogin ? "login-required" : "check-sso",
        checkLoginIframe: false,
        redirectUri: window.location.origin + "/login",
      });

      if (authenticated && kc.token) {
        api.setToken(kc.token);
        sessionStorage.setItem(TOKEN_KEY, kc.token);
        sessionStorage.setItem(PROVIDER_KEY, "keycloak");

        // Automatic token refresh
        setupTokenRefresh(kc);

        // Fetch user info
        try {
          const user = await api.me();
          setState({
            user,
            token: kc.token,
            isAuthenticated: true,
            provider: "keycloak",
          });
        } catch {
          // Keycloak token valid but /me fails?
          setState({
            user: {
              id: kc.subject || "",
              username:
                (kc.tokenParsed as any)?.preferred_username || "unknown",
              email: (kc.tokenParsed as any)?.email || "",
              role: "READONLY",
              createdAt: new Date().toISOString(),
            },
            token: kc.token,
            isAuthenticated: true,
            provider: "keycloak",
          });
        }
      }
    } catch (err) {
      console.error("[Auth] Keycloak init failed:", err);
    }
  };

  // Refresh the Keycloak token before expiration
  const setupTokenRefresh = (kc: Keycloak) => {
    setInterval(async () => {
      try {
        const refreshed = await kc.updateToken(30); // refresh if expiring in <30s
        if (refreshed && kc.token) {
          api.setToken(kc.token);
          sessionStorage.setItem(TOKEN_KEY, kc.token);
          setState((prev) => ({ ...prev, token: kc.token! }));
        }
      } catch {
        // Session expired
        kc.login();
      }
    }, 10_000); // check every 10s
  };

  // Restore local session via httpOnly cookie: we simply call
  // /me, the cookie is sent automatically by the browser (credentials).
  // If 200 → active session. If 401 → not logged in, back to login.
  const restoreLocalSession = async () => {
    const provider = sessionStorage.getItem(PROVIDER_KEY);
    if (provider === "keycloak") return; // handled by initKeycloak

    try {
      const user = await api.me();
      setState({
        user,
        token: null, // never stored on the JS side for local auth anymore
        isAuthenticated: true,
        provider: "local",
      });
    } catch {
      // No active session: OK, the user will go to /login
      sessionStorage.removeItem(PROVIDER_KEY);
    }
  };

  // Local login: the backend sets an httpOnly cookie, we have nothing to
  // store on the JS side. We just mark the provider so the next boot
  // knows what to try.
  const login = useCallback(async (username: string, password: string) => {
    const response = await api.login(username, password);
    sessionStorage.setItem(PROVIDER_KEY, "local");
    setState({
      user: response.user,
      token: null,
      isAuthenticated: true,
      provider: "local",
    });
  }, []);

  // Keycloak login (redirect to Keycloak — same instance as the AuthProvider)
  const loginKeycloak = useCallback(() => {
    const kc = keycloakRef.current;
    if (!kc) {
      console.error("[Auth] Keycloak instance not available");
      return;
    }
    // kc.login() builds the URL and redirects, no prior init needed
    // The return to /login with the code will be handled by the AuthProvider on remount
    kc.login({ redirectUri: window.location.origin + "/login" });
  }, []);

  // Logout: for local auth, call /api/auth/logout which clears the
  // httpOnly cookie on the server side BEFORE clearing the state. Otherwise a re-mount
  // (StrictMode dev, F5, or re-render) would see the cookie still valid,
  // restoreLocalSession would call /me successfully and the user would come back
  // to the dashboard "on their own".
  // For Keycloak, redirect to the OIDC logout which invalidates the session on the IdP side.
  const logout = useCallback(async () => {
    const provider = sessionStorage.getItem(PROVIDER_KEY);

    if (provider === "keycloak" && keycloakRef.current) {
      // Keycloak handles its own logout flow via redirect — no local cookie
      // to clear, we clear the state then trigger the redirect.
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(PROVIDER_KEY);
      api.setToken(null);
      setState({
        user: null,
        token: null,
        isAuthenticated: false,
        provider: null,
      });
      keycloakRef.current.logout({
        redirectUri: window.location.origin + "/login",
      });
      return;
    }

    // Local auth: must await the backend cookie clear, otherwise the
    // browser keeps the cookie and /me re-authenticates on the next render.
    try {
      await api.logout();
    } catch (err) {
      console.warn("[Auth] logout call failed (cookie may persist):", err);
    }

    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(PROVIDER_KEY);
    api.setToken(null);
    setState({
      user: null,
      token: null,
      isAuthenticated: false,
      provider: null,
    });
  }, []);

  // Register the 401 callback on the API client
  // When the API receives a 401, we force logout
  useEffect(() => {
    api.setOnUnauthorized(() => {
      console.warn("[Auth] Session expired — forcing logout");
      logout();
    });
  }, [logout]);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        login,
        loginKeycloak,
        logout,
        loading,
        authConfig,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
