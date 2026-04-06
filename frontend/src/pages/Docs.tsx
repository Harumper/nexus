import { useState } from "react";
import { Book, Server, Shield, Terminal, Download, Tag, Zap, Bell, Settings, Network, ChevronRight } from "lucide-react";

type Section = "start" | "agent" | "probe" | "machines" | "tags" | "profiles" | "alerts" | "updates" | "api" | "security";

const sections: { id: Section; label: string; icon: typeof Book }[] = [
  { id: "start", label: "Démarrage rapide", icon: Book },
  { id: "agent", label: "Installation Agent", icon: Terminal },
  { id: "probe", label: "Mode Probe", icon: Network },
  { id: "machines", label: "Gestion des machines", icon: Server },
  { id: "tags", label: "Tags & Groupes", icon: Tag },
  { id: "profiles", label: "Profils", icon: Zap },
  { id: "alerts", label: "Alertes & Notifications", icon: Bell },
  { id: "updates", label: "Mises à jour", icon: Download },
  { id: "security", label: "Sécurité", icon: Shield },
  { id: "api", label: "API Reference", icon: Settings },
];

export default function Docs() {
  const [active, setActive] = useState<Section>("start");

  return (
    <div className="flex h-full">
      {/* Doc sidebar */}
      <nav className="w-56 shrink-0 py-4 overflow-y-auto" style={{ borderRight: "1px solid var(--nx-border)" }}>
        {sections.map((s) => (
          <button
            key={s.id}
            onClick={() => setActive(s.id)}
            className="flex items-center gap-2 w-full px-4 py-2 text-xs transition-colors text-left"
            style={{
              color: active === s.id ? "var(--nx-primary)" : "var(--nx-text-weak)",
              background: active === s.id ? "var(--nx-primary-subtle)" : "transparent",
              fontWeight: active === s.id ? 600 : 400,
            }}
          >
            <s.icon className="w-3.5 h-3.5 shrink-0" />
            {s.label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8 max-w-3xl">
        <DocContent section={active} />
      </div>
    </div>
  );
}

function DocContent({ section }: { section: Section }) {
  switch (section) {
    case "start": return <StartDoc />;
    case "agent": return <AgentDoc />;
    case "probe": return <ProbeDoc />;
    case "machines": return <MachinesDoc />;
    case "tags": return <TagsDoc />;
    case "profiles": return <ProfilesDoc />;
    case "alerts": return <AlertsDoc />;
    case "updates": return <UpdatesDoc />;
    case "security": return <SecurityDoc />;
    case "api": return <ApiDoc />;
  }
}

/* ── Shared components ──────────────────── */

function H1({ children }: { children: React.ReactNode }) {
  return <h1 className="text-xl font-bold text-foreground mb-4">{children}</h1>;
}
function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-bold text-foreground mt-6 mb-2 flex items-center gap-1.5"><ChevronRight className="w-3.5 h-3.5 text-primary" />{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground mb-3 leading-relaxed">{children}</p>;
}
function Code({ children }: { children: string }) {
  return (
    <pre className="rounded-lg p-4 text-xs font-mono overflow-x-auto mb-4" style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border)", color: "var(--nx-text)" }}>
      {children}
    </pre>
  );
}
function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-3 mb-4 text-xs" style={{ background: "var(--nx-primary-subtle)", borderLeft: "3px solid var(--nx-primary)", color: "var(--nx-text)" }}>
      <span className="font-bold text-primary">Tip : </span>{children}
    </div>
  );
}
function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-3 mb-4 text-xs" style={{ background: "var(--nx-warning-subtle)", borderLeft: "3px solid var(--nx-warning)", color: "var(--nx-text)" }}>
      <span className="font-bold" style={{ color: "var(--nx-warning)" }}>Attention : </span>{children}
    </div>
  );
}

/* ── Sections ───────────────────────────── */

function StartDoc() {
  return (<>
    <H1>Démarrage rapide</H1>
    <P>Nexus est une plateforme de gestion d'infrastructure qui permet de surveiller, mettre à jour et administrer vos serveurs Ubuntu/Debian depuis une interface web unifiée.</P>

    <H2>Architecture</H2>
    <P>Nexus se compose de 3 éléments :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">Serveur Nexus</strong> — Backend Fastify + Frontend React, déployé via Docker Compose</li>
      <li><strong className="text-foreground">Agent Nexus</strong> — Binaire Go installé sur chaque machine à gérer (service systemd)</li>
      <li><strong className="text-foreground">Probe Nexus</strong> — Version légère de l'agent (monitoring uniquement, pas d'actions)</li>
    </ul>

    <H2>Prérequis</H2>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li>Docker + Docker Compose sur le serveur Nexus</li>
      <li>Ubuntu 20.04+ ou Debian 11+ sur les machines cibles</li>
      <li>Accès réseau entre les machines et le serveur Nexus (port 26033)</li>
    </ul>

    <H2>Installation du serveur</H2>
    <Code>{`# Cloner le projet
git clone <repo> nexus && cd nexus

# Configurer l'environnement
cp .env.example .env
# Modifier .env avec vos valeurs (JWT_SECRET, ECDSA_MASTER_SECRET, etc.)

# Lancer
docker compose up -d

# Le dashboard est accessible sur :
#   https://localhost:26033  (HTTPS auto-signé)
#   http://localhost:26032   (redirige vers HTTPS)`}</Code>

    <H2>Premier login</H2>
    <P>Connectez-vous avec le compte admin créé par le seed de la base de données. Changez le mot de passe après la première connexion.</P>

    <H2>Ajouter votre première machine</H2>
    <P>Depuis le Dashboard ou la page Machines, cliquez sur "Ajouter une machine". Nexus génère un token d'enrollment unique valable 24h. Utilisez ce token pour installer l'agent sur la machine cible.</P>
  </>);
}

function AgentDoc() {
  return (<>
    <H1>Installation de l'Agent</H1>
    <P>L'agent Nexus est un binaire Go léger qui s'installe comme service systemd sur chaque machine à gérer.</P>

    <H2>1. Créer la machine dans Nexus</H2>
    <P>Depuis l'interface web, allez dans Machines → Ajouter une machine. Choisissez un nom et les capabilities souhaitées. Nexus vous donne :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">Machine ID</strong> — Identifiant unique</li>
      <li><strong className="text-foreground">Enrollment Token</strong> — Token d'authentification (valable 24h)</li>
      <li><strong className="text-foreground">Backend Public Key</strong> — Clé publique du serveur</li>
    </ul>

    <H2>2. Installer l'agent via le script</H2>
    <Code>{`# Sur la machine cible (en root)
sudo bash install.sh \\
  --server wss://nexus-server:26033 \\
  --token enroll_xxxxxxxxxxxx \\
  --machine-id cmxxxxxxxxx \\
  --server-key "-----BEGIN PUBLIC KEY-----..."`}</Code>

    <P>Le script :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li>Crée l'utilisateur système <code className="text-xs px-1 rounded" style={{ background: "var(--nx-bg-elevated)" }}>nexus</code></li>
      <li>Copie le binaire dans <code className="text-xs px-1 rounded" style={{ background: "var(--nx-bg-elevated)" }}>/usr/local/bin/nexus-agent</code></li>
      <li>Crée la config dans <code className="text-xs px-1 rounded" style={{ background: "var(--nx-bg-elevated)" }}>/etc/nexus/agent.env</code></li>
      <li>Installe et démarre le service systemd</li>
    </ul>

    <H2>3. Installation manuelle</H2>
    <Code>{`# Copier le binaire
sudo cp nexus-agent /usr/local/bin/
sudo chmod +x /usr/local/bin/nexus-agent

# Créer la config
sudo mkdir -p /etc/nexus /opt/nexus/keys
sudo tee /etc/nexus/agent.env << EOF
NEXUS_SERVER_URL=wss://nexus-server:26033/ws/agent
NEXUS_MACHINE_ID=<machine-id>
NEXUS_ENROLLMENT_TOKEN=<token>
NEXUS_KEY_PATH=/opt/nexus/keys
NEXUS_HEARTBEAT_INTERVAL=30
NEXUS_METRICS_INTERVAL=60
EOF

# Installer le service systemd
sudo cp nexus-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-agent

# Vérifier
sudo systemctl status nexus-agent
sudo journalctl -u nexus-agent -f`}</Code>

    <H2>4. Vérification</H2>
    <P>Après le démarrage, l'agent :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li>Se connecte au serveur via WebSocket (WSS)</li>
      <li>Effectue l'enrollment ECDSA (échange de clés)</li>
      <li>Commence à envoyer des heartbeats (toutes les 30s) et des métriques (toutes les 60s)</li>
      <li>La machine passe en statut <strong className="text-foreground">ONLINE</strong> dans le dashboard</li>
    </ul>

    <Tip>L'enrollment est automatique au premier démarrage. Les clés sont stockées dans /opt/nexus/keys/ et réutilisées aux démarrages suivants.</Tip>

    <H2>Capabilities</H2>
    <P>Les capabilities déterminent ce que l'agent peut faire :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">monitoring</strong> — Métriques CPU/RAM/Disk, processus, infos système</li>
      <li><strong className="text-foreground">updates</strong> — Vérification et installation des mises à jour apt</li>
      <li><strong className="text-foreground">packages</strong> — Installation/suppression de packages</li>
      <li><strong className="text-foreground">scripts</strong> — Exécution de scripts, kill de processus</li>
    </ul>
  </>);
}

function ProbeDoc() {
  return (<>
    <H1>Mode Probe</H1>
    <P>La probe est une version allégée de l'agent, limitée au monitoring. Elle ne peut pas exécuter d'actions dangereuses (mises à jour, installation de packages, scripts).</P>

    <H2>Quand utiliser une Probe ?</H2>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li>Machines en production critique où vous ne voulez pas d'actions à distance</li>
      <li>Surveillance passive uniquement (métriques, alertes)</li>
      <li>Environnements à sécurité renforcée</li>
    </ul>

    <H2>Déploiement Docker</H2>
    <Code>{`# La probe est disponible via docker-compose
docker compose --profile probe up -d`}</Code>

    <H2>Déploiement natif</H2>
    <P>Utilisez le même binaire agent avec la variable d'environnement :</P>
    <Code>{`NEXUS_AGENT_TYPE=probe`}</Code>

    <H2>Différences Agent vs Probe</H2>
    <div className="rounded-lg overflow-hidden mb-4" style={{ border: "1px solid var(--nx-border)" }}>
      <table className="w-full text-xs">
        <thead><tr style={{ background: "var(--nx-bg-elevated)" }}>
          <th className="text-left px-3 py-2 text-muted-foreground">Fonctionnalité</th>
          <th className="text-center px-3 py-2 text-muted-foreground">Agent</th>
          <th className="text-center px-3 py-2 text-muted-foreground">Probe</th>
        </tr></thead>
        <tbody>
          {[
            ["Métriques CPU/RAM/Disk/Réseau", true, true],
            ["Liste des processus", true, true],
            ["Détection reboot requis", true, true],
            ["Mises à jour système", true, false],
            ["Installation de packages", true, false],
            ["Exécution de scripts", true, false],
            ["Kill de processus", true, false],
          ].map(([feat, agent, probe], i) => (
            <tr key={i} style={{ borderTop: "1px solid var(--nx-border)" }}>
              <td className="px-3 py-1.5 text-foreground">{feat as string}</td>
              <td className="px-3 py-1.5 text-center">{agent ? "✅" : "❌"}</td>
              <td className="px-3 py-1.5 text-center">{probe ? "✅" : "❌"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </>);
}

function MachinesDoc() {
  return (<>
    <H1>Gestion des machines</H1>
    <P>La page Machines affiche toutes les machines enregistrées avec leur statut en temps réel.</P>

    <H2>Statuts</H2>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-emerald-400">ONLINE</strong> — L'agent est connecté et envoie des données</li>
      <li><strong className="text-red-400">OFFLINE</strong> — Plus de heartbeat depuis 90s</li>
      <li><strong className="text-blue-400">ENROLLMENT_PENDING</strong> — Machine créée, en attente de connexion de l'agent</li>
      <li><strong className="text-amber-400">STALE</strong> — Offline depuis plus de 7 jours (configurable)</li>
      <li><strong className="text-muted-foreground">ARCHIVED</strong> — Offline depuis plus de 30 jours</li>
      <li><strong className="text-red-400">REVOKED</strong> — Clés révoquées, l'agent ne peut plus se connecter</li>
    </ul>

    <H2>Cycle de vie automatique</H2>
    <P>Les machines inactives suivent un cycle automatique (délais configurables dans Paramètres) :</P>
    <Code>{`OFFLINE → (7 jours) → STALE → (30 jours) → ARCHIVED → (90 jours) → Supprimée`}</Code>

    <H2>Actions</H2>
    <P>Depuis la page détail d'une machine (cliquez sur une carte) :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">Vue d'ensemble</strong> — Infos système, réseau, capabilities, stockage</li>
      <li><strong className="text-foreground">Métriques</strong> — Graphiques CPU/RAM/Disk/Load/Réseau avec historique</li>
      <li><strong className="text-foreground">Mises à jour</strong> — Vérifier et installer les MAJ système</li>
      <li><strong className="text-foreground">Processus</strong> — Liste des processus en cours, possibilité de kill</li>
      <li><strong className="text-foreground">Réseau</strong> — Détail des interfaces réseau et débit</li>
    </ul>

    <H2>Suppression / Révocation</H2>
    <P>Le menu contextuel (⋮) sur chaque carte machine permet de révoquer ou supprimer. La révocation invalide les clés de l'agent — il ne pourra plus se reconnecter sans un re-enrollment.</P>
  </>);
}

function TagsDoc() {
  return (<>
    <H1>Tags & Groupes</H1>
    <P>Les tags permettent d'organiser vos machines (ex: "prod", "web", "db"). Les groupes permettent de regrouper des machines pour des actions en masse.</P>

    <H2>Tags</H2>
    <P>Créez des tags depuis la page Tags. Chaque tag a un nom et une couleur. Assignez des tags aux machines depuis la page détail de la machine.</P>
    <Tip>Les tags sont utilisés par les Profils pour cibler les machines sur lesquelles exécuter des actions automatiques.</Tip>

    <H2>Groupes</H2>
    <P>Deux types de groupes :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">Statique</strong> — Vous ajoutez/retirez manuellement les machines</li>
      <li><strong className="text-foreground">Dynamique</strong> — Les machines sont résolues automatiquement selon des filtres (tags, statut)</li>
    </ul>
  </>);
}

function ProfilesDoc() {
  return (<>
    <H1>Profils</H1>
    <P>Les profils automatisent des actions sur vos machines. Ils ciblent les machines via des tags.</P>

    <H2>Types de profils</H2>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-blue-400">UPGRADE</strong> — Mises à jour système (toutes ou sécurité uniquement)</li>
      <li><strong className="text-amber-400">REBOOT</strong> — Reboot planifié (jours/heure configurables)</li>
      <li><strong className="text-purple-400">SCRIPT</strong> — Exécution d'un script bash sur les machines cibles</li>
      <li><strong className="text-emerald-400">PACKAGE</strong> — Installation ou suppression de packages</li>
    </ul>

    <H2>Staggered delivery</H2>
    <P>Pour les profils UPGRADE, vous pouvez définir une fenêtre de délivrance (en minutes). Les actions seront envoyées aux machines de manière échelonnée dans cette fenêtre pour éviter de surcharger le réseau.</P>

    <H2>Exécution</H2>
    <P>Les profils peuvent être exécutés manuellement depuis l'interface (bouton "Exécuter"). L'historique des exécutions est visible pour chaque profil.</P>
    <Warn>Les profils SCRIPT exécutent du code arbitraire sur vos machines. Seuls les admins peuvent créer et exécuter des profils.</Warn>
  </>);
}

function AlertsDoc() {
  return (<>
    <H1>Alertes & Notifications</H1>
    <P>Configurez des règles d'alerte pour être notifié quand une machine dépasse un seuil ou devient inaccessible.</P>

    <H2>Types de conditions</H2>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">CPU_ABOVE</strong> — CPU dépasse X%</li>
      <li><strong className="text-foreground">MEMORY_ABOVE</strong> — RAM dépasse X%</li>
      <li><strong className="text-foreground">DISK_ABOVE</strong> — Disque dépasse X%</li>
      <li><strong className="text-foreground">LOAD_ABOVE</strong> — Load average dépasse X</li>
      <li><strong className="text-foreground">MACHINE_OFFLINE</strong> — Machine hors ligne depuis X secondes</li>
    </ul>

    <H2>Notifications</H2>
    <P>Deux canaux de notification disponibles :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">Webhook</strong> — POST HTTP signé HMAC-SHA256 vers une URL de votre choix</li>
      <li><strong className="text-foreground">Email</strong> — Via SMTP (Gmail supporté). Configurez dans Paramètres.</li>
    </ul>

    <H2>Configuration SMTP (Gmail)</H2>
    <Code>{`Host: smtp.gmail.com
Port: 587
User: votre.email@gmail.com
Password: (mot de passe d'application Google)
From: votre.email@gmail.com`}</Code>
    <Tip>Pour Gmail, vous devez créer un "mot de passe d'application" dans les paramètres de sécurité de votre compte Google.</Tip>
  </>);
}

function UpdatesDoc() {
  return (<>
    <H1>Mises à jour système</H1>
    <P>Nexus peut vérifier et installer les mises à jour système sur vos machines Ubuntu/Debian.</P>

    <H2>Vérification</H2>
    <P>Depuis la page détail d'une machine → onglet "Mises à jour" → "Vérifier les MAJ". L'agent exécute <code className="text-xs px-1 rounded" style={{ background: "var(--nx-bg-elevated)" }}>apt-get update</code> et retourne la liste des packages à mettre à jour.</P>

    <H2>Installation</H2>
    <P>Deux options :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">Tout mettre à jour</strong> — Exécute <code className="text-xs px-1 rounded" style={{ background: "var(--nx-bg-elevated)" }}>apt-get upgrade -y</code></li>
      <li><strong className="text-foreground">Sécurité uniquement</strong> — Exécute <code className="text-xs px-1 rounded" style={{ background: "var(--nx-bg-elevated)" }}>unattended-upgrades</code></li>
    </ul>

    <H2>Mise à jour en masse</H2>
    <P>Depuis le Dashboard, le bouton "Tout mettre à jour" lance les mises à jour sur toutes les machines en ligne. Utilisez les Profils pour plus de contrôle (staggered delivery, ciblage par tags).</P>

    <Warn>Les mises à jour sont exécutées en root sur la machine cible. Un reboot peut être nécessaire après certaines mises à jour (kernel). L'indicateur "Reboot requis" apparaîtra sur la machine.</Warn>
  </>);
}

function SecurityDoc() {
  return (<>
    <H1>Sécurité</H1>
    <P>Nexus utilise plusieurs couches de sécurité pour protéger les communications et les actions.</P>

    <H2>Chiffrement des communications</H2>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">TLS</strong> — HTTPS auto-signé pour le frontend (configurable)</li>
      <li><strong className="text-foreground">ECDSA P-256</strong> — Signature de chaque message agent ↔ serveur</li>
      <li><strong className="text-foreground">AES-256-GCM</strong> — Chiffrement du payload des messages</li>
      <li><strong className="text-foreground">ECDH</strong> — Dérivation du secret partagé lors de l'enrollment</li>
    </ul>

    <H2>Anti-replay</H2>
    <P>Chaque message contient un nonce unique et un timestamp. Les nonces sont stockés dans un cache LRU (TTL 5 min) pour détecter les tentatives de replay.</P>

    <H2>Authentification</H2>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">JWT local</strong> — Authentification par username/password</li>
      <li><strong className="text-foreground">Keycloak SSO</strong> — Authentification OIDC (configurable)</li>
      <li><strong className="text-foreground">WebSocket Dashboard</strong> — Token JWT vérifié lors de la connexion WS</li>
    </ul>

    <H2>Rôles</H2>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">ADMIN</strong> — Accès total (créer/supprimer machines, profils, tags, etc.)</li>
      <li><strong className="text-foreground">OPERATOR</strong> — Lecture + actions sur les machines</li>
      <li><strong className="text-foreground">READONLY</strong> — Lecture seule</li>
    </ul>
  </>);
}

function ApiDoc() {
  return (<>
    <H1>API Reference</H1>
    <P>Toutes les routes API nécessitent un header <code className="text-xs px-1 rounded" style={{ background: "var(--nx-bg-elevated)" }}>Authorization: Bearer &lt;token&gt;</code>.</P>

    <H2>Authentification</H2>
    <Code>{`POST /api/auth/login     { username, password } → { token, user }
GET  /api/auth/me         → User
GET  /api/auth/config     → { mode, local, keycloak }`}</Code>

    <H2>Machines</H2>
    <Code>{`GET    /api/machines              → Machine[]
GET    /api/machines/:id          → Machine
POST   /api/machines              { name, capabilities } → Machine (ADMIN)
DELETE /api/machines/:id          (ADMIN)
POST   /api/machines/:id/revoke   { reason } (ADMIN)
POST   /api/machines/:id/re-enroll (ADMIN)`}</Code>

    <H2>Actions</H2>
    <Code>{`POST /api/machines/:id/actions/sync  { action_id, params?, timeout? } → { success, data }
POST /api/machines/:id/actions       { action_id, params? } → { request_id }
POST /api/machines/actions/batch     { action_id, machine_ids?, params? } (ADMIN)`}</Code>

    <H2>Métriques</H2>
    <Code>{`GET /api/machines/:id/metrics?range=1h    → { metrics[], count }
GET /api/machines/:id/metrics/latest     → Metric
GET /api/fleet/summary                   → FleetSummary
GET /api/fleet/trends?range=1h           → { buckets[] }`}</Code>

    <H2>Tags & Groupes</H2>
    <Code>{`GET/POST        /api/tags              (ADMIN)
PUT/DELETE      /api/tags/:id          (ADMIN)
POST/DELETE     /api/machines/:id/tags (ADMIN)
GET/POST        /api/groups            (ADMIN)
GET             /api/groups/:id/machines`}</Code>

    <H2>Profils</H2>
    <Code>{`GET/POST        /api/profiles          (ADMIN)
PUT/DELETE      /api/profiles/:id      (ADMIN)
POST            /api/profiles/:id/execute (ADMIN)
GET             /api/profiles/:id/executions`}</Code>

    <H2>Alertes</H2>
    <Code>{`GET/POST        /api/alerts/rules
PUT/DELETE      /api/alerts/rules/:id
GET             /api/alerts/active
GET             /api/alerts/history`}</Code>

    <H2>Paramètres</H2>
    <Code>{`GET /api/settings         → Setting[]
PUT /api/settings/:key   { value } (ADMIN)`}</Code>

    <H2>Audit</H2>
    <Code>{`GET /api/audit?limit=50&page=1   → AuditLog[]`}</Code>
  </>);
}
