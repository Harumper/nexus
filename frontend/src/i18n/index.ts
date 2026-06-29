import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import frCommon from "./locales/fr/common.json";
import enCommon from "./locales/en/common.json";
import frAuth from "./locales/fr/auth.json";
import enAuth from "./locales/en/auth.json";
import frSettings from "./locales/fr/settings.json";
import enSettings from "./locales/en/settings.json";
import frContainers from "./locales/fr/containers.json";
import enContainers from "./locales/en/containers.json";

export const SUPPORTED_LANGUAGES = ["fr", "en"] as const;

// Un namespace par module fonctionnel. "common" = chrome + libellés transverses
// (référencé partout) → c'est le defaultNS. Les lots suivants ajoutent leur
// propre namespace (alerts, machineDetail, docs…) sans toucher à common.
export const DEFAULT_NS = "common";
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "fr";
export const LANG_STORAGE_KEY = "nexus-lang";

// Ordre de détection STRICT : localStorage("nexus-lang") → fallback fr.
// On n'utilise PAS navigator.language : un visiteur en locale EN doit voir
// FR par défaut (FR est la langue native du produit). Lecture directe de
// localStorage (calquée sur ThemeContext) plutôt qu'un plugin détecteur,
// pour garder le contrôle exact de l'ordre et une dépendance de moins.
export function getInitialLanguage(): Language {
  const stored = localStorage.getItem(LANG_STORAGE_KEY);
  if (stored === "fr" || stored === "en") return stored;
  return DEFAULT_LANGUAGE;
}

// Init synchrone : les ressources sont des bundles statiques importés (pas de
// lazy), donc i18n est prêt dès l'import de ce module — aucun flash d'écran
// vide à attendre. `useSuspense: false` par sécurité (pas de Suspense i18n).
i18n.use(initReactI18next).init({
  resources: {
    fr: { common: frCommon, auth: frAuth, settings: frSettings, containers: frContainers },
    en: { common: enCommon, auth: enAuth, settings: enSettings, containers: enContainers },
  },
  ns: ["common", "auth", "settings", "containers"],
  defaultNS: DEFAULT_NS,
  lng: getInitialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export default i18n;
