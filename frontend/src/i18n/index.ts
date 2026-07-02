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
import frDashboard from "./locales/fr/dashboard.json";
import enDashboard from "./locales/en/dashboard.json";
import frMachines from "./locales/fr/machines.json";
import enMachines from "./locales/en/machines.json";
import frCompare from "./locales/fr/compare.json";
import enCompare from "./locales/en/compare.json";
import frMetricsChart from "./locales/fr/metricsChart.json";
import enMetricsChart from "./locales/en/metricsChart.json";
import frAttention from "./locales/fr/attention.json";
import enAttention from "./locales/en/attention.json";
import frAudit from "./locales/fr/audit.json";
import enAudit from "./locales/en/audit.json";
import frEnroll from "./locales/fr/enroll.json";
import enEnroll from "./locales/en/enroll.json";
import frAlerts from "./locales/fr/alerts.json";
import enAlerts from "./locales/en/alerts.json";
import frMachineDetail from "./locales/fr/machineDetail.json";
import enMachineDetail from "./locales/en/machineDetail.json";
import frFirewall from "./locales/fr/firewall.json";
import enFirewall from "./locales/en/firewall.json";
import frNetwork from "./locales/fr/network.json";
import enNetwork from "./locales/en/network.json";
import frServices from "./locales/fr/services.json";
import enServices from "./locales/en/services.json";
import frStorage from "./locales/fr/storage.json";
import enStorage from "./locales/en/storage.json";
import frPackages from "./locales/fr/packages.json";
import enPackages from "./locales/en/packages.json";
import frScheduling from "./locales/fr/scheduling.json";
import enScheduling from "./locales/en/scheduling.json";
import frProcessList from "./locales/fr/processList.json";
import enProcessList from "./locales/en/processList.json";
import frUpdatePanel from "./locales/fr/updatePanel.json";
import enUpdatePanel from "./locales/en/updatePanel.json";
import frSecurity from "./locales/fr/security.json";
import enSecurity from "./locales/en/security.json";
import frUsers from "./locales/fr/users.json";
import enUsers from "./locales/en/users.json";
import frFiles from "./locales/fr/files.json";
import enFiles from "./locales/en/files.json";
import frAgentUpgrade from "./locales/fr/agentUpgrade.json";
import enAgentUpgrade from "./locales/en/agentUpgrade.json";
import frBulkAction from "./locales/fr/bulkAction.json";
import enBulkAction from "./locales/en/bulkAction.json";
import frBatchUpdate from "./locales/fr/batchUpdate.json";
import enBatchUpdate from "./locales/en/batchUpdate.json";
import frLogsDrawer from "./locales/fr/logsDrawer.json";
import enLogsDrawer from "./locales/en/logsDrawer.json";
import frDocs from "./locales/fr/docs.json";
import enDocs from "./locales/en/docs.json";
import frSshConnect from "./locales/fr/sshConnect.json";
import enSshConnect from "./locales/en/sshConnect.json";
import frLogShipping from "./locales/fr/logShipping.json";
import enLogShipping from "./locales/en/logShipping.json";

export const SUPPORTED_LANGUAGES = ["fr", "en"] as const;

// One namespace per functional module. "common" = chrome + cross-cutting labels
// (referenced everywhere) → it's the defaultNS. The following lots add their
// own namespace (alerts, machineDetail, docs…) without touching common.
export const DEFAULT_NS = "common";
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "fr";
export const LANG_STORAGE_KEY = "nexus-lang";

// STRICT detection order: localStorage("nexus-lang") → fallback fr.
// We do NOT use navigator.language: a visitor in an EN locale must see
// FR by default (FR is the product's native language). Direct read of
// localStorage (modeled on ThemeContext) rather than a detector plugin,
// to keep exact control of the order and one fewer dependency.
export function getInitialLanguage(): Language {
  const stored = localStorage.getItem(LANG_STORAGE_KEY);
  if (stored === "fr" || stored === "en") return stored;
  return DEFAULT_LANGUAGE;
}

// Synchronous init: the resources are statically imported bundles (no
// lazy), so i18n is ready as soon as this module is imported — no flash of an
// empty screen to wait through. `useSuspense: false` for safety (no i18n Suspense).
i18n.use(initReactI18next).init({
  resources: {
    fr: {
      common: frCommon, auth: frAuth, settings: frSettings, containers: frContainers,
      dashboard: frDashboard, machines: frMachines, compare: frCompare,
      metricsChart: frMetricsChart, attention: frAttention, audit: frAudit, enroll: frEnroll, alerts: frAlerts,
      machineDetail: frMachineDetail, firewall: frFirewall, network: frNetwork,
      services: frServices, storage: frStorage, packages: frPackages, scheduling: frScheduling, processList: frProcessList,
      updatePanel: frUpdatePanel, security: frSecurity, users: frUsers, files: frFiles,
      agentUpgrade: frAgentUpgrade, bulkAction: frBulkAction, batchUpdate: frBatchUpdate, logsDrawer: frLogsDrawer,
      docs: frDocs, sshConnect: frSshConnect, logShipping: frLogShipping,
    },
    en: {
      common: enCommon, auth: enAuth, settings: enSettings, containers: enContainers,
      dashboard: enDashboard, machines: enMachines, compare: enCompare,
      metricsChart: enMetricsChart, attention: enAttention, audit: enAudit, enroll: enEnroll, alerts: enAlerts,
      machineDetail: enMachineDetail, firewall: enFirewall, network: enNetwork,
      services: enServices, storage: enStorage, packages: enPackages, scheduling: enScheduling, processList: enProcessList,
      updatePanel: enUpdatePanel, security: enSecurity, users: enUsers, files: enFiles,
      agentUpgrade: enAgentUpgrade, bulkAction: enBulkAction, batchUpdate: enBatchUpdate, logsDrawer: enLogsDrawer,
      docs: enDocs, sshConnect: enSshConnect, logShipping: enLogShipping,
    },
  },
  ns: ["common", "auth", "settings", "containers", "dashboard", "machines", "compare", "metricsChart", "attention", "audit", "enroll", "alerts", "machineDetail", "firewall", "network", "services", "storage", "packages", "scheduling", "processList", "updatePanel", "security", "users", "files", "agentUpgrade", "bulkAction", "batchUpdate", "logsDrawer", "docs", "sshConnect", "logShipping"],
  defaultNS: DEFAULT_NS,
  lng: getInitialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export default i18n;
