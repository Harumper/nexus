// Gating des actions "à persistance hors-bande" : ajout/suppression de clés
// SSH et bascule du groupe sudo. Contrairement aux autres actions (firewall,
// services, reboot…) qui restent dans le périmètre de Nexus (tracées,
// révocables, dépendantes de l'agent), ces trois-là créent un accès qui
// SURVIT à la désinstallation de l'agent et n'est plus révocable par Nexus.
//
// Double verrou :
//   1. Désactivées par défaut — il faut ALLOW_USER_PRIVILEGE_MGMT=true.
//   2. Réservées au rôle ADMIN, même flag activé.
//
// Le contrôle est appliqué dans dispatchAction() — donc il couvre TOUS les
// chemins de dispatch (/actions/sync, /actions, /bulk, batch).

import { PROBE_ALLOWED_ACTIONS } from "./machine-manager.js";

export const PRIVILEGED_USER_ACTIONS = new Set<string>([
  "user.update_sudo",
  "sshkey.add",
  "sshkey.remove",
]);

// Actions en lecture seule = la liste PROBE (source unique de vérité). Un
// utilisateur READONLY ne peut invoquer QUE celles-ci.
const READ_ONLY_ACTIONS = new Set<string>(PROBE_ALLOWED_ACTIONS);

// Actions si dangereuses qu'elles exigent ADMIN même si elles restent dans le
// périmètre Nexus (révocables, tracées) : script.execute = exécution root
// arbitraire sur la machine cible.
export const ADMIN_ONLY_ACTIONS = new Set<string>(["script.execute"]);

// Exécution distante de script = root arbitraire (amplificateur de kill-chain).
// Opt-in DÉSACTIVÉ par défaut, en plus d'ADMIN-only : un parc confiné n'a aucune
// voie d'exécution de script, même pour un ADMIN, tant que le flag est off. Verrou
// indépendant de la signature (clé locale, côté agent) et de la capacité sudoers
// (ligne omise à l'install) — les trois doivent être réunis. process.kill
// rejoindra cet ensemble en 0.8 (AGENT-004), hors périmètre de ce fix.
export const REMOTE_SCRIPT_ACTIONS = new Set<string>(["script.execute"]);

// Activé uniquement si ALLOW_REMOTE_SCRIPT vaut explicitement "true".
export function isRemoteScriptAllowed(): boolean {
  return (process.env.ALLOW_REMOTE_SCRIPT || "").toLowerCase() === "true";
}

// Gate central (appliqué dans dispatchAction → couvre sync/async/bulk/batch) :
// quand le flag est off, l'action est refusée pour TOUS (y compris appels
// internes), car la fonctionnalité entière est désactivée.
export function checkRemoteScriptAction(actionId: string): {
  allowed: boolean;
  reason?: string;
} {
  if (!REMOTE_SCRIPT_ACTIONS.has(actionId)) return { allowed: true };
  if (!isRemoteScriptAllowed()) {
    return {
      allowed: false,
      reason: `Action '${actionId}' is disabled. Set ALLOW_REMOTE_SCRIPT=true to enable remote script execution (ADMIN-only, signed scripts).`,
    };
  }
  return { allowed: true };
}

// RBAC par action, appliqué centralement dans dispatchAction() — couvre donc
// TOUS les chemins de dispatch (/actions/sync, /actions, /bulk, batch).
//
// IMPORTANT sur userRole === undefined : c'est la signature d'un appel SYSTÈME
// interne (agent-upgrade, alert-engine poll de santé) — jamais déclenché
// directement par un utilisateur non authentifié (les routes HTTP qui les
// initient sont gardées séparément, ex. requireAdmin sur l'upgrade). Tout appel
// d'un utilisateur authentifié porte TOUJOURS un rôle (les JWT local ET
// Keycloak incluent `role`), donc la restriction ci-dessous s'applique bien aux
// utilisateurs. On traite donc undefined comme appel interne de confiance, et
// tout rôle inconnu en fail-closed.
export function checkRoleForAction(
  actionId: string,
  userRole?: string
): { allowed: boolean; reason?: string } {
  // Appel système interne (pas de rôle) → confiance.
  if (userRole === undefined) return { allowed: true };

  // ADMIN : tout.
  if (userRole === "ADMIN") return { allowed: true };

  // READONLY : uniquement les actions en lecture seule.
  if (userRole === "READONLY") {
    if (READ_ONLY_ACTIONS.has(actionId)) return { allowed: true };
    return {
      allowed: false,
      reason: `Action '${actionId}' requires OPERATOR or ADMIN role (read-only account).`,
    };
  }

  // OPERATOR : mutations autorisées, sauf les actions réservées ADMIN.
  if (userRole === "OPERATOR") {
    if (ADMIN_ONLY_ACTIONS.has(actionId)) {
      return {
        allowed: false,
        reason: `Action '${actionId}' requires ADMIN role.`,
      };
    }
    return { allowed: true };
  }

  // Rôle inconnu → fail-closed.
  return {
    allowed: false,
    reason: `Action '${actionId}' not permitted for role '${userRole}'.`,
  };
}

// Activé uniquement si la variable d'env vaut explicitement "true".
// Toute autre valeur (absente, "false", "0"…) → désactivé.
export function isUserPrivilegeMgmtEnabled(): boolean {
  return (process.env.ALLOW_USER_PRIVILEGE_MGMT || "").toLowerCase() === "true";
}

// Une action est "privilégiée" si elle accorde/retire des accès persistants :
//   - bascule sudo (user.update_sudo)
//   - clés SSH (sshkey.add / sshkey.remove)
//   - création d'un utilisateur DIRECTEMENT dans le groupe sudo
//     (user.create avec params.sudo === true) — sinon c'est un contournement
//     trivial de la bascule sudo.
export function isPrivilegedUserAction(
  actionId: string,
  params?: Record<string, unknown>
): boolean {
  if (PRIVILEGED_USER_ACTIONS.has(actionId)) return true;
  if (actionId === "user.create" && params?.sudo === true) return true;
  return false;
}

// Renvoie { allowed } pour une action donnée et un rôle d'appelant.
// userRole peut être undefined (appel système interne) → traité comme
// non-ADMIN, donc refusé pour les actions privilégiées (fail-closed).
export function checkPrivilegedAction(
  actionId: string,
  userRole?: string,
  params?: Record<string, unknown>
): { allowed: boolean; reason?: string } {
  if (!isPrivilegedUserAction(actionId, params)) {
    return { allowed: true };
  }

  if (!isUserPrivilegeMgmtEnabled()) {
    return {
      allowed: false,
      reason: `Action '${actionId}' is disabled. Set ALLOW_USER_PRIVILEGE_MGMT=true to enable user privilege management (SSH keys / sudo).`,
    };
  }

  if (userRole !== "ADMIN") {
    return {
      allowed: false,
      reason: `Action '${actionId}' requires ADMIN role.`,
    };
  }

  return { allowed: true };
}
