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
import type { User, AuthState, AuthConfig } from "../types";

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  loading: boolean;
  authConfig: AuthConfig | null;
}

const AuthContext = createContext<AuthContextType | null>(null);

const TOKEN_KEY = "nexus_token";
const PROVIDER_KEY = "nexus_provider";

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
  const initRef = useRef(false);

  // 1. Charger la config auth du backend au démarrage
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    fetch("/api/auth/config")
      .then((r) => r.json())
      .then(async (config: AuthConfig) => {
        setAuthConfig(config);

        const savedProvider = sessionStorage.getItem(PROVIDER_KEY);

        // Si Keycloak est activé et c'est le provider principal
        if (
          config.keycloak &&
          (config.mode === "keycloak" || savedProvider === "keycloak")
        ) {
          await initKeycloak(config);
        } else if (config.local) {
          // Restaurer session locale
          await restoreLocalSession();
        } else if (config.keycloak) {
          // Fallback: init Keycloak si local n'est pas dispo
          await initKeycloak(config);
        }

        setLoading(false);
      })
      .catch(() => {
        // Si le backend n'est pas dispo, tenter local
        restoreLocalSession().finally(() => setLoading(false));
      });
  }, []);

  // Init Keycloak
  const initKeycloak = async (config: AuthConfig) => {
    if (!config.keycloak) return;

    const kc = new Keycloak({
      url: config.keycloak.url,
      realm: config.keycloak.realm,
      clientId: config.keycloak.clientId,
    });

    keycloakRef.current = kc;

    try {
      const authenticated = await kc.init({
        onLoad: "check-sso",
        silentCheckSsoRedirectUri:
          window.location.origin + "/silent-check-sso.html",
        checkLoginIframe: false,
      });

      if (authenticated && kc.token) {
        api.setToken(kc.token);
        sessionStorage.setItem(TOKEN_KEY, kc.token);
        sessionStorage.setItem(PROVIDER_KEY, "keycloak");

        // Refresh token automatique
        setupTokenRefresh(kc);

        // Récupérer les infos user
        try {
          const user = await api.me();
          setState({
            user,
            token: kc.token,
            isAuthenticated: true,
            provider: "keycloak",
          });
        } catch {
          // Token Keycloak valide mais /me échoue ?
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

  // Refresh token Keycloak avant expiration
  const setupTokenRefresh = (kc: Keycloak) => {
    setInterval(async () => {
      try {
        const refreshed = await kc.updateToken(30); // refresh si expire dans <30s
        if (refreshed && kc.token) {
          api.setToken(kc.token);
          sessionStorage.setItem(TOKEN_KEY, kc.token);
          setState((prev) => ({ ...prev, token: kc.token! }));
        }
      } catch {
        // Session expirée
        kc.login();
      }
    }, 10_000); // vérifier toutes les 10s
  };

  // Restaurer session locale
  const restoreLocalSession = async () => {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const provider = sessionStorage.getItem(PROVIDER_KEY);

    if (token && provider !== "keycloak") {
      api.setToken(token);
      try {
        const user = await api.me();
        setState({
          user,
          token,
          isAuthenticated: true,
          provider: "local",
        });
      } catch {
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(PROVIDER_KEY);
        api.setToken(null);
      }
    }
  };

  // Login local
  const login = useCallback(async (username: string, password: string) => {
    const response = await api.login(username, password);
    sessionStorage.setItem(TOKEN_KEY, response.token);
    sessionStorage.setItem(PROVIDER_KEY, "local");
    api.setToken(response.token);
    setState({
      user: response.user,
      token: response.token,
      isAuthenticated: true,
      provider: "local",
    });
  }, []);

  // Login Keycloak (redirect)
  const loginKeycloak = useCallback(() => {
    if (keycloakRef.current) {
      keycloakRef.current.login();
    }
  }, []);

  // Logout
  const logout = useCallback(() => {
    const provider = sessionStorage.getItem(PROVIDER_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(PROVIDER_KEY);
    api.setToken(null);
    setState({
      user: null,
      token: null,
      isAuthenticated: false,
      provider: null,
    });

    // Si Keycloak, aussi logout côté Keycloak
    if (provider === "keycloak" && keycloakRef.current) {
      keycloakRef.current.logout({
        redirectUri: window.location.origin + "/login",
      });
    }
  }, []);

  // Enregistrer le callback 401 sur l'API client
  // Quand l'API reçoit un 401, on force la déconnexion
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

// Hook pour lancer le login Keycloak (redirect)
export function useKeycloakLogin() {
  const { authConfig } = useAuth();

  return useCallback(() => {
    if (!authConfig?.keycloak) return;

    const kc = new Keycloak({
      url: authConfig.keycloak.url,
      realm: authConfig.keycloak.realm,
      clientId: authConfig.keycloak.clientId,
    });

    kc.init({ onLoad: "login-required" });
  }, [authConfig]);
}
