import { useState, useEffect } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import {
  LayoutDashboard,
  Server,
  Bell,
  ScrollText,
  Settings,
  BarChart3,
  LogOut,
  User,
  Palette,
  Languages,
  BookOpen,
  Container,
} from "lucide-react";
import { useTheme } from "../contexts/ThemeContext";
import { useLanguage } from "../contexts/LanguageContext";
import { SUPPORTED_LANGUAGES } from "../i18n";
import { api } from "../services/api";

type TFunc = (key: string) => string;

function buildNavSections(integrations: { nautilusEnabled: boolean }, t: TFunc) {
  return [
    {
      items: [
        { to: "/", icon: LayoutDashboard, label: t("nav.dashboard") },
        { to: "/machines", icon: Server, label: t("nav.machines") },
        ...(integrations.nautilusEnabled
          ? [{ to: "/containers", icon: Container, label: t("nav.containers") }]
          : []),
      ],
    },
    {
      label: t("nav.groupManagement"),
      items: [
        { to: "/alerts", icon: Bell, label: t("nav.alerts") },
      ],
    },
    {
      label: t("nav.groupAnalysis"),
      items: [
        { to: "/compare", icon: BarChart3, label: t("nav.compare") },
        { to: "/audit", icon: ScrollText, label: t("nav.audit") },
      ],
    },
    {
      label: t("nav.groupSystem"),
      items: [
        { to: "/settings", icon: Settings, label: t("nav.settings") },
        { to: "/docs", icon: BookOpen, label: t("nav.docs") },
      ],
    },
  ];
}

export default function Layout() {
  const { t } = useTranslation();
  const { user, logout, provider } = useAuth();
  const { theme, setTheme } = useTheme();
  const { language, setLanguage } = useLanguage();
  const navigate = useNavigate();
  const [nautilusEnabled, setNautilusEnabled] = useState(false);

  useEffect(() => {
    // Load integrations config once for menu visibility
    api.getNautilusConfig().then((c) => setNautilusEnabled(c.enabled)).catch((err) => console.warn("[Layout] nautilus config failed:", err));
  }, []);

  const navSections = buildNavSections({ nautilusEnabled }, t);

  const handleLogout = async () => {
    // await impératif : logout est désormais async (attend que le backend
    // clear le cookie httpOnly avant de vider le state local). Sans await,
    // le navigate() partait avant le clear et le cookie persistait.
    await logout();
    navigate("/login");
  };

  return (
    <div className="h-screen flex bg-background overflow-hidden">
      {/* Sidebar */}
      <aside
        className="w-[220px] flex flex-col shrink-0"
        style={{ background: "var(--nx-bg-sidebar)", borderRight: "1px solid var(--nx-border)" }}
      >
        {/* Logo */}
        <div
          className="h-14 flex items-center gap-2.5 px-4"
          style={{ borderBottom: "1px solid var(--nx-border)" }}
        >
          <img
            src="/nexus-icon.svg"
            alt="Nexus"
            className="w-8 h-8 object-contain shrink-0"
          />
          <span className="text-[15px] font-bold text-foreground tracking-tight">Nexus</span>
          <span
            className="text-[9px] font-bold px-1.5 py-0.5 rounded ml-auto uppercase tracking-wider"
            style={{ background: "var(--nx-primary-subtle)", color: "var(--nx-primary)" }}
          >
            v2
          </span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-2 overflow-y-auto">
          {navSections.map((section, si) => (
            <div key={si} className={section.label ? "mt-3" : ""}>
              {section.label && (
                <div className="px-4 mb-1">
                  <span
                    className="text-[10px] font-semibold uppercase tracking-widest"
                    style={{ color: "var(--nx-text-weak)" }}
                  >
                    {section.label}
                  </span>
                </div>
              )}
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className="flex items-center gap-2.5 mx-2 px-3 py-[7px] rounded-lg text-[13px] transition-all"
                  style={({ isActive }) => ({
                    color: isActive ? "var(--nx-primary)" : "var(--nx-text-weak)",
                    background: isActive ? "var(--nx-primary-subtle)" : "transparent",
                    fontWeight: isActive ? 600 : 400,
                  })}
                >
                  <item.icon className="w-[16px] h-[16px]" />
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {/* Theme */}
        <div className="px-4 py-3" style={{ borderTop: "1px solid var(--nx-border)" }}>
          <div className="flex items-center gap-1.5 mb-2">
            <Palette className="w-3 h-3" style={{ color: "var(--nx-text-weak)" }} />
            <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--nx-text-weak)" }}>
              {t("theme.label")}
            </span>
          </div>
          <div className="flex gap-1.5">
            {([
              { id: "dark" as const, bg: "#111217", label: t("theme.dark") },
              { id: "light" as const, bg: "#f3f4f6", label: t("theme.light") },
              { id: "blue" as const, bg: "#0a101e", label: t("theme.navy") },
            ]).map((opt) => (
              <button
                key={opt.id}
                onClick={() => setTheme(opt.id)}
                title={opt.label}
                className="w-6 h-6 rounded-full transition-transform"
                style={{
                  background: opt.bg,
                  border: theme === opt.id ? `2px solid var(--nx-primary)` : "2px solid var(--nx-border)",
                  transform: theme === opt.id ? "scale(1.15)" : "scale(1)",
                }}
              />
            ))}
          </div>
        </div>

        {/* Language */}
        <div className="px-4 py-3" style={{ borderTop: "1px solid var(--nx-border)" }}>
          <div className="flex items-center gap-1.5 mb-2">
            <Languages className="w-3 h-3" style={{ color: "var(--nx-text-weak)" }} />
            <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--nx-text-weak)" }}>
              {t("language.label")}
            </span>
          </div>
          <div className="flex gap-1.5">
            {SUPPORTED_LANGUAGES.map((lng) => (
              <button
                key={lng}
                onClick={() => setLanguage(lng)}
                className="px-2.5 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide transition-colors"
                style={{
                  background: language === lng ? "var(--nx-primary-subtle)" : "transparent",
                  color: language === lng ? "var(--nx-primary)" : "var(--nx-text-weak)",
                  border: language === lng ? "1px solid var(--nx-primary)" : "1px solid var(--nx-border)",
                }}
              >
                {lng}
              </button>
            ))}
          </div>
        </div>

        {/* User */}
        <div className="px-3 py-2.5" style={{ borderTop: "1px solid var(--nx-border)" }}>
          <div className="flex items-center gap-2.5">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-muted-foreground"
              style={{ background: "var(--nx-bg-elevated)" }}
            >
              <User className="w-3.5 h-3.5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground truncate">{user?.username}</div>
              <div className="text-[10px] text-muted-foreground">
                {user?.role}{provider === "keycloak" ? " · SSO" : ""}
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
              title={t("user.logout")}
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto bg-background">
        <Outlet />
      </main>
    </div>
  );
}
