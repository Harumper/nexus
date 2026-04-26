import { useState } from "react";
import { Book, Server, Shield, Terminal, Download, Tag, Bell, Settings, Network, ChevronRight } from "lucide-react";

type Section = "start" | "agent" | "probe" | "self" | "machines" | "tags" | "alerts" | "updates" | "ssh" | "api" | "security";

const sections: { id: Section; label: string; icon: typeof Book }[] = [
  { id: "start", label: "Démarrage rapide", icon: Book },
  { id: "agent", label: "Installation Agent", icon: Terminal },
  { id: "probe", label: "Mode Probe", icon: Network },
  { id: "self", label: "Self-monitoring", icon: Server },
  { id: "machines", label: "Gestion des machines", icon: Server },
  { id: "tags", label: "Tags & Groupes", icon: Tag },
  { id: "alerts", label: "Alertes & Notifications", icon: Bell },
  { id: "updates", label: "Mises à jour", icon: Download },
  { id: "ssh", label: "Configuration SSH", icon: Terminal },
  { id: "security", label: "Sécurité", icon: Shield },
  { id: "api", label: "API Reference", icon: Settings },
];

export default function Docs() {
  const initial = (() => {
    const p = new URLSearchParams(window.location.search);
    const s = p.get("section") as Section | null;
    const valid: Section[] = ["start", "agent", "probe", "self", "machines", "tags", "alerts", "updates", "ssh", "security", "api"];
    return s && valid.includes(s) ? s : "start";
  })();
  const [active, setActive] = useState<Section>(initial);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Book className="w-6 h-6" /> Documentation
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Guide d'utilisation de Nexus
        </p>
      </div>

      {/* Horizontal tabs */}
      <div className="flex flex-wrap gap-1 mb-6 border-b border-border">
        {sections.map((s) => {
          const Icon = s.icon;
          const isActive = active === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors -mb-px"
              style={{
                color: isActive ? "var(--nx-primary)" : "var(--nx-text-weak)",
                borderBottom: isActive ? "2px solid var(--nx-primary)" : "2px solid transparent",
              }}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              {s.label}
            </button>
          );
        })}
      </div>

      <DocContent section={active} />
    </div>
  );
}

function DocContent({ section }: { section: Section }) {
  switch (section) {
    case "start": return <StartDoc />;
    case "agent": return <AgentDoc />;
    case "probe": return <ProbeDoc />;
    case "self": return <SelfDoc />;
    case "machines": return <MachinesDoc />;
    case "tags": return <TagsDoc />;
    case "alerts": return <AlertsDoc />;
    case "updates": return <UpdatesDoc />;
    case "ssh": return <SshDoc />;
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
    <P>Depuis l'interface web, allez dans Machines → Ajouter une machine. Choisissez un nom et un type (<strong>AGENT</strong> complet ou <strong>PROBE</strong> monitoring read-only). Nexus vous donne :</P>
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

    <H2>Type de machine</H2>
    <P>Le type détermine ce que l'agent peut faire :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">AGENT</strong> — Accès complet : métriques, mises à jour, services, firewall, netplan, users, paquets, reboot, etc.</li>
      <li><strong className="text-foreground">PROBE</strong> — Monitoring en lecture seule uniquement (métriques, logs, statuts). Aucune mutation possible.</li>
    </ul>
    <P>Le type est défini à la création de la machine et peut être changé dans la section <em>Paramètres</em> de la vue d'ensemble.</P>

    <H2>Flag "Machine critique"</H2>
    <P>Dans <em>Paramètres</em>, cochez <strong>⚠ Machine critique</strong> pour les machines sensibles (serveur Nexus, prod DB, etc.). Cela bloque :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><code>system.reboot</code></li>
      <li><code>service_stop/restart</code> sur docker, nginx, ssh, postgresql, traefik, keycloak</li>
      <li><code>package.remove</code> sur docker-ce, nginx, postgresql, openssh-*, systemd, sudo, apt</li>
    </ul>

    <H2>Réinstallation (sudoers obsolètes)</H2>
    <P>
      Quand une nouvelle version de Nexus ajoute des règles sudo (nouvelles actions agent),
      les agents existants gardent leurs anciens sudoers et les nouvelles actions échouent.
      Un badge <strong className="text-foreground">⚠ Sudoers obsolètes</strong> apparaît
      sur la machine. Pour resynchroniser :
    </P>
    <Code>{`# 1. SSH sur la machine concernée
ssh user@machine-ip

# 2. Re-télécharge le script depuis Nexus et le relance avec les mêmes paramètres
#    qu'à l'install initiale (l'enrollment token n'est plus nécessaire si l'agent
#    a déjà ses clés ECDSA dans /var/lib/nexus/keys/)
sudo bash install-agent.sh \\
  --server-url wss://nexus.example.com/ws/agent \\
  --machine-id <machine-id> \\
  --reinstall

# 3. Redémarre le service pour que l'agent recharge le hash sudoers
sudo systemctl restart nexus-agent`}</Code>
    <P>
      Au prochain heartbeat (~30s), le badge disparaît automatiquement.
    </P>

    <H2>Désinstallation complète</H2>
    <P>
      Pour retirer entièrement l'agent d'une machine (avant suppression de la machine
      dans Nexus, ou avant un ré-enrôlement propre depuis zéro) :
    </P>
    <Code>{`# Sur la machine cible, en root
sudo systemctl stop nexus-agent 2>/dev/null
sudo systemctl disable nexus-agent 2>/dev/null

# Service unit + binaire
sudo rm -f /etc/systemd/system/nexus-agent.service
sudo rm -f /usr/local/bin/nexus-agent

# Clés ECDSA (CRITIQUE pour ré-enrôlement propre — sans -agent dans le path)
sudo rm -rf /var/lib/nexus
# Configuration agent (sans -agent dans le path)
sudo rm -rf /etc/nexus
# Scripts/snapshots watchdog (avec -agent)
sudo rm -rf /var/lib/nexus-agent

# Sudoers
sudo rm -f /etc/sudoers.d/nexus-agent

# Groupes systemd-journal
sudo gpasswd -d nexus-agent systemd-journal 2>/dev/null

# Utilisateur
sudo userdel nexus-agent 2>/dev/null

# Reload systemd
sudo systemctl daemon-reload

echo "Cleanup done"`}</Code>
    <Warn>
      Cette commande supprime aussi les <strong>clés ECDSA</strong> et le shared secret. Si
      tu veux ré-enrôler la machine ensuite, tu devras créer une nouvelle entrée dans
      l'UI (les anciennes clés ne sont plus valables).
    </Warn>

    <H2>Ré-enrôlement propre</H2>
    <P>
      Si tu veux repartir de zéro (clés régénérées, statut remis à <em>ENROLLMENT_PENDING</em>) :
    </P>
    <ol className="list-decimal list-inside text-sm text-muted-foreground mb-4 space-y-1 ml-2">
      <li>Désinstalle l'agent (script ci-dessus)</li>
      <li>Dans l'UI Nexus → la machine → bouton <strong>Re-enroll</strong> (régénère un token + nouvelle paire ECDSA)</li>
      <li>Copie la nouvelle commande d'install et exécute-la sur la machine</li>
    </ol>
    <P>
      Alternative : supprime entièrement la machine dans Nexus et recrée-en une nouvelle. Plus propre si la machine a été remise à zéro.
    </P>
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

function SelfDoc() {
  return (<>
    <H1>Self-monitoring — Installer l'agent sur le serveur Nexus</H1>
    <P>
      Pour surveiller le serveur Nexus lui-même (métriques, services, disk, updates), vous pouvez installer un agent Nexus sur la machine qui héberge Nexus. L'agent tourne en natif sur l'hôte (pas dans un container) et remonte vers l'instance Nexus locale.
    </P>

    <Tip>
      Dogfooding : permet de détecter un serveur Nexus qui rame (CPU saturé, disk plein, container restart), et de recevoir des alertes. Si Nexus tombe complètement, vous ne verrez rien — c'est une limite attendue.
    </Tip>

    <H2>1. Créer la machine "nexus-server"</H2>
    <P>
      Dans l'UI Nexus → Machines → Ajouter une machine. Nom suggéré : <code>nexus-server</code>, type <strong>AGENT</strong>.
    </P>

    <H2>2. Exécuter la commande d'install sur l'hôte</H2>
    <P>
      Copier la commande fournie par l'UI et l'exécuter directement sur l'hôte (pas dans un container). L'agent se connecte à Nexus via <code>ws://localhost:3000/ws/agent</code> ou le nom de domaine public selon votre config.
    </P>
    <Warn>
      <strong>Cas particulier Docker</strong> : si Nexus tourne derrière un reverse proxy (nginx/traefik), utilisez l'URL publique dans <code>--server-url</code>. Sinon, vérifiez que le backend est exposé sur localhost:3000.
    </Warn>

    <H2>3. Vérification</H2>
    <P>
      La machine <code>nexus-server</code> apparaît en <span className="text-emerald-400">ONLINE</span> dans quelques secondes. Vous voyez :
    </P>
    <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-3 ml-2">
      <li>CPU/RAM de l'hôte (pas du container Nexus)</li>
      <li>Le disk du volume Docker</li>
      <li>Les services systemd (docker.service, etc.)</li>
      <li>Les timers cron/apt</li>
      <li>Les certs SSL du reverse proxy</li>
    </ul>

    <H2>Alertes recommandées pour le serveur Nexus</H2>
    <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-3 ml-2">
      <li><strong>DISK_ABOVE 85%</strong> sur nexus-server — évite que les logs Docker / volumes Postgres remplissent le disque</li>
      <li><strong>MEMORY_ABOVE 90%</strong> — Nexus + Postgres consomment</li>
      <li><strong>SERVICE_FAILED "docker"</strong> — si Docker tombe, tout Nexus tombe</li>
      <li><strong>CERT_EXPIRING 14</strong> jours — pour le cert du reverse proxy public</li>
      <li><strong>UPDATES_AVAILABLE threshold 50</strong> — rappel de patch</li>
    </ul>
    <P>
      Ces alertes passent par webhook/email standard. En cas de panne Nexus complète, elles ne se déclencheront pas (d'où l'intérêt d'un monitoring externe type uptime-kuma en parallèle).
    </P>
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

    <H2>Onglets par machine</H2>
    <P>Depuis la page détail d'une machine (cliquez sur une carte), 11 onglets regroupés en 5 catégories :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">Vue d'ensemble</strong> — Infos système, réseau, paramètres éditables, SSL certs</li>
      <li><strong className="text-foreground">Monitoring</strong> — Métriques (CPU/RAM/Disk/Load historique), Processus, Stockage (LVM/FS/block)</li>
      <li><strong className="text-foreground">Système</strong> — Services systemd (list + logs + start/stop/restart), Tâches (timers + cron + toggle), Utilisateurs (CRUD + clés SSH)</li>
      <li><strong className="text-foreground">Réseau</strong> — Interfaces, Netplan (éditeur YAML + watchdog 120s), Pare-feu ufw (allow/deny + watchdog 60s)</li>
      <li><strong className="text-foreground">Logiciels</strong> — Mises à jour (apt upgrade + package hold/unhold), Paquets (recherche FTS + install/remove)</li>
    </ul>

    <H2>Actions groupées (bulk)</H2>
    <P>Sur la page Machines, cochez plusieurs machines pour faire apparaître le bouton <strong>Action groupée (N)</strong>. Vous pouvez lancer en parallèle sur jusqu'à 100 machines :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li>Mise à jour système / sécurité</li>
      <li>Redémarrage (avec confirmation textuelle "REBOOT")</li>
      <li>Upgrade de l'agent</li>
      <li>Start/Stop/Restart d'un service</li>
      <li>Install/Remove/Hold/Unhold d'un paquet</li>
    </ul>
    <P>Les actions watchdog-revert (netplan, firewall) restent individuelles par machine (confirmation obligatoire).</P>

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

function AlertsDoc() {
  return (<>
    <H1>Alertes & Notifications</H1>
    <P>Configurez des règles d'alerte pour être notifié quand une machine dépasse un seuil ou devient inaccessible.</P>

    <H2>Types de conditions</H2>
    <p className="text-sm font-semibold text-foreground mb-2">Métriques (évaluées à chaque heartbeat, ~30s)</p>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">CPU_ABOVE</strong> — CPU dépasse X%</li>
      <li><strong className="text-foreground">MEMORY_ABOVE</strong> — RAM dépasse X%</li>
      <li><strong className="text-foreground">DISK_ABOVE</strong> — Un disque dépasse X%</li>
      <li><strong className="text-foreground">LOAD_ABOVE</strong> — Load average dépasse X</li>
    </ul>
    <p className="text-sm font-semibold text-foreground mb-2">Connexion (évalué toutes les 60s)</p>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">MACHINE_OFFLINE</strong> — Machine hors ligne depuis X secondes</li>
    </ul>
    <p className="text-sm font-semibold text-foreground mb-2">Santé système (évalué toutes les 5 min, polls l'agent)</p>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">SERVICE_FAILED</strong> — Service systemd en échec. Filtre optionnel par nom (ex: "nginx", "postgres").</li>
      <li><strong className="text-foreground">TIMER_FAILED</strong> — Timer systemd dont le service active a échoué.</li>
      <li><strong className="text-foreground">CRON_FAILED</strong> — Cron job en échec (préparation).</li>
      <li><strong className="text-foreground">UPDATES_AVAILABLE</strong> — Plus de N mises à jour apt disponibles (threshold = N).</li>
    </ul>
    <p className="text-sm font-semibold text-foreground mb-2">Sécurité (évalué toutes les 6h)</p>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1">
      <li><strong className="text-foreground">CERT_EXPIRING</strong> — Au moins un cert SSL expire dans ≤ N jours (threshold = N).</li>
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
    <P>Depuis la page Machines, sélectionnez plusieurs machines via les checkboxes puis cliquez <strong>Action groupée → Mise à jour système</strong>. Dispatch en parallèle avec concurrence limitée à 10 machines. Les résultats sont consolidés dans une table (OK / Échec / Skipped).</P>
    <P>Alternative : les Profils permettent de planifier les mises à jour avec staggered delivery et ciblage par tags.</P>

    <H2>Package pinning (apt-mark hold)</H2>
    <P>Dans l'onglet <strong>Logiciels → Mises à jour</strong>, chaque paquet à upgrader a une icône cadenas dans la colonne Hold :</P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-3 space-y-1">
      <li><strong>Cadenas ouvert</strong> (gris) : le paquet suivra le prochain upgrade.</li>
      <li><strong>Cadenas fermé</strong> (orange) : paquet "held" via <code>apt-mark hold</code>, ne sera PAS upgradé.</li>
    </ul>
    <P>Cas d'usage : bloquer un kernel précis en attendant de valider un reboot, ou figer postgresql sur une version LTS.</P>

    <Warn>Les mises à jour sont exécutées en root sur la machine cible. Un reboot peut être nécessaire après certaines mises à jour (kernel). L'indicateur "Reboot requis" apparaîtra sur la machine.</Warn>
  </>);
}

function SshDoc() {
  return (<>
    <H1>Configuration SSH</H1>
    <P>
      Le bouton <strong>SSH</strong> dans la page d'une machine utilise le scheme <code>ssh://</code> pour ouvrir votre terminal local pré-connecté. Ce scheme n'est pas configuré par défaut sur les OS modernes. Voici comment l'activer.
    </P>

    <Tip>Vous pouvez toujours copier la commande <code>ssh user@ip</code> et la coller manuellement dans votre terminal, sans configuration.</Tip>

    <H2>macOS</H2>
    <P>
      Terminal.app n'est plus enregistré comme handler <code>ssh://</code> par défaut depuis macOS 10.6. Le moyen le plus simple pour le réactiver :
    </P>
    <Code>{`brew install --cask swiftdefaultappsprefpane
# Puis Réglages système → SwiftDefaultApps → URL Schemes
# Associer "ssh" à Terminal.app (ou iTerm2, Warp...)`}</Code>

    <H2>Linux (GNOME / KDE / Xfce)</H2>
    <P>
      Créer un fichier <code>.desktop</code> qui déclare le handler :
    </P>
    <Code>{`# ~/.local/share/applications/ssh-handler.desktop
[Desktop Entry]
Name=SSH Handler
Exec=gnome-terminal -- ssh %u
Type=Application
Terminal=false
MimeType=x-scheme-handler/ssh;
NoDisplay=true`}</Code>
    <P>Puis enregistrer le handler :</P>
    <Code>{`update-desktop-database ~/.local/share/applications/
xdg-mime default ssh-handler.desktop x-scheme-handler/ssh`}</Code>
    <P>
      Remplacez <code>gnome-terminal --</code> par votre émulateur si besoin :
    </P>
    <Code>{`# KDE
Exec=konsole --new-tab -e ssh %u
# Xfce
Exec=xfce4-terminal -e "ssh %u"
# Alacritty
Exec=alacritty -e ssh %u`}</Code>

    <H2>Windows 10/11 avec WSL</H2>
    <P>
      Si vous utilisez <strong>WSL</strong> (Windows Subsystem for Linux), le plus simple est de rediriger <code>ssh://</code> vers <code>wsl ssh</code>. Créez un fichier <code>nexus-ssh-wsl.reg</code> :
    </P>
    <Code>{`Windows Registry Editor Version 5.00
[HKEY_CLASSES_ROOT\\ssh]
"URL Protocol"=""
@="URL:ssh"
[HKEY_CLASSES_ROOT\\ssh\\shell\\open\\command]
@="\\"C:\\\\Windows\\\\System32\\\\wsl.exe\\" ssh %1"`}</Code>
    <P>
      Double-cliquer sur le fichier, confirmer l'import. Le terminal WSL s'ouvrira désormais avec la connexion SSH pré-établie.
    </P>
    <Tip>
      Pour un meilleur rendu dans <strong>Windows Terminal</strong> (profil WSL par défaut) :
      <code className="block mt-2 font-mono">@="\"C:\\Windows\\System32\\cmd.exe\" /c start wt.exe wsl ssh %1"</code>
    </Tip>

    <H2>Windows 10/11 sans WSL</H2>
    <P>
      <strong>OpenSSH natif</strong> (inclus dans Windows 10+). Créez un <code>.reg</code> utilisant <code>wt.exe</code> :
    </P>
    <Code>{`Windows Registry Editor Version 5.00
[HKEY_CLASSES_ROOT\\ssh]
"URL Protocol"=""
@="URL:ssh"
[HKEY_CLASSES_ROOT\\ssh\\shell\\open\\command]
@="\\"C:\\\\Windows\\\\System32\\\\cmd.exe\\" /c start wt.exe ssh %1"`}</Code>
    <P>
      Nécessite Windows Terminal 1.16+ et <code>Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0</code> si le client SSH n'est pas installé.
    </P>

    <H2>Windows — PuTTY (legacy)</H2>
    <P>
      Lors de l'installation de PuTTY, cocher « associer aux URL ssh:// ». Simple mais rendu visuel moins bon que WSL/Windows Terminal.
    </P>

    <H2>Pré-remplir le nom d'utilisateur</H2>
    <P>
      Dans la page <strong>Vue d'ensemble</strong> d'une machine, la carte <em>Paramètres</em> permet de renseigner un utilisateur SSH par défaut (ex: <code>root</code>, <code>ubuntu</code>). Il sera pré-rempli automatiquement dans le bouton SSH pour cette machine.
    </P>
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
    <Code>{`GET    /api/machines                   → Machine[]
GET    /api/machines/:id               → Machine
POST   /api/machines                   { name, type? } → Machine (ADMIN)
PATCH  /api/machines/:id               { name?, sshUser?, isCritical? } (ADMIN)
DELETE /api/machines/:id               (ADMIN)
POST   /api/machines/:id/revoke        { reason } (ADMIN)
POST   /api/machines/:id/re-enroll     (ADMIN)
POST   /api/machines/:id/agent/upgrade (ADMIN) — self-upgrade agent
POST   /api/bulk/dispatch              { action_id, machineIds[], params?, mode? } (ADMIN)`}</Code>

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
