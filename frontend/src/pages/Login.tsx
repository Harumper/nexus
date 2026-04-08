import { useState, useEffect, type FormEvent } from "react";
import { useAuth } from "../hooks/useAuth";
import Keycloak from "keycloak-js";
import { Shield, KeyRound, LogIn } from "lucide-react";

export default function Login() {
  const { login, authConfig, loading: authLoading } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Si mode keycloak only, redirect automatiquement
  useEffect(() => {
    if (authConfig?.mode === "keycloak" && authConfig.keycloak) {
      redirectToKeycloak(authConfig.keycloak);
    }
  }, [authConfig]);

  const handleLocalLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError("Veuillez remplir tous les champs");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await login(username.trim(), password);
    } catch (err: any) {
      if (err.status === 429) {
        setError("Trop de tentatives. Réessayez dans une minute.");
      } else {
        setError(err.message || "Identifiants invalides");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleKeycloakLogin = () => {
    if (authConfig?.keycloak) {
      redirectToKeycloak(authConfig.keycloak);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const showKeycloak = authConfig?.keycloak != null;
  const showLocal = authConfig?.local ?? true;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm mx-auto">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-4">
            <Shield className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Nexus</h1>
          <p className="text-muted-foreground mt-1">
            Infrastructure Management
          </p>
        </div>

        <div className="space-y-4">
          {/* Bouton Keycloak SSO */}
          {showKeycloak && (
            <button
              onClick={handleKeycloakLogin}
              className="w-full flex items-center justify-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              <KeyRound className="w-5 h-5 text-primary" />
              Se connecter avec SSO
            </button>
          )}

          {/* Séparateur si les deux modes sont actifs */}
          {showKeycloak && showLocal && (
            <div className="flex items-center gap-4">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground">ou</span>
              <div className="flex-1 h-px bg-border" />
            </div>
          )}

          {/* Formulaire local */}
          {showLocal && (
            <form onSubmit={handleLocalLogin}>
              <div className="rounded-xl border border-border bg-card p-6 space-y-4">
                {error && (
                  <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
                    {error}
                  </div>
                )}

                <div>
                  <label
                    htmlFor="username"
                    className="block text-sm font-medium text-foreground mb-1.5"
                  >
                    Utilisateur
                  </label>
                  <input
                    id="username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="admin"
                    required
                    autoFocus={!showKeycloak}
                  />
                </div>

                <div>
                  <label
                    htmlFor="password"
                    className="block text-sm font-medium text-foreground mb-1.5"
                  >
                    Mot de passe
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    required
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  <LogIn className="w-4 h-4" />
                  {loading ? "Connexion..." : "Se connecter"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function redirectToKeycloak(config: {
  url: string;
  realm: string;
  clientId: string;
}) {
  // Construire l'URL de login Keycloak manuellement pour redirect vers /
  // Evite de creer une instance Keycloak concurrente avec l'AuthProvider
  const redirectUri = encodeURIComponent(window.location.origin + "/login");
  const authUrl = `${config.url}/realms/${config.realm}/protocol/openid-connect/auth`
    + `?client_id=${encodeURIComponent(config.clientId)}`
    + `&redirect_uri=${redirectUri}`
    + `&response_type=code`
    + `&scope=openid`;
  window.location.href = authUrl;
}
