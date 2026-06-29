import { useState, useEffect, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { KeyRound, LogIn } from "lucide-react";
import { getErrorMessage } from "../services/errors";

export default function Login() {
  const { t } = useTranslation("auth");
  const { login, loginKeycloak, authConfig, loading: authLoading } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Si mode keycloak only, redirect automatiquement
  // IMPORTANT : ne pas redirect si un code OIDC est dans l'URL (retour de Keycloak,
  // l'AuthProvider est en train d'echanger le code) OU si l'auth charge encore.
  useEffect(() => {
    if (authLoading) return;
    const hasOidcCode =
      window.location.hash.includes("code=") || window.location.search.includes("code=");
    if (hasOidcCode) return;
    if (authConfig?.mode === "keycloak" && authConfig.keycloak) {
      loginKeycloak();
    }
  }, [authConfig, loginKeycloak, authLoading]);

  const handleLocalLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError(t("errors.emptyFields"));
      return;
    }
    setError("");
    setLoading(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      if ((err as { status?: number })?.status === 429) {
        setError(t("errors.tooManyAttempts"));
      } else {
        setError(getErrorMessage(err, t("errors.invalidCredentials")));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleKeycloakLogin = () => {
    loginKeycloak();
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
          <img
            src="/nexus-logo.svg"
            alt="Nexus"
            className="h-12 mx-auto mb-4 dark:hidden"
          />
          <img
            src="/nexus-logo-dark.svg"
            alt="Nexus"
            className="h-12 mx-auto mb-4 hidden dark:block"
          />
          <p className="text-muted-foreground mt-1">
            {t("tagline")}
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
              {t("ssoButton")}
            </button>
          )}

          {/* Séparateur si les deux modes sont actifs */}
          {showKeycloak && showLocal && (
            <div className="flex items-center gap-4">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground">{t("separator")}</span>
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
                    {t("usernameLabel")}
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
                    {t("passwordLabel")}
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
                  {loading ? t("submitting") : t("submit")}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

