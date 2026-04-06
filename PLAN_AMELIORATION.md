# Plan Nexus v2 — Amélioration majeure

## Contexte

Nexus est une plateforme de gestion d'infrastructure self-hosted (Fastify 5 + React 19 + Agent Go + PostgreSQL 16). L'analyse comparative avec Canonical Landscape a révélé des failles de sécurité, des fonctionnalités manquantes pour la gestion de flotte, et un dashboard à repenser.

**Décisions structurantes prises** :
- Réseau local uniquement (pas d'exposition internet) → certificats auto-signés
- Auth : Keycloak principal + login local en fallback → les deux doivent être validés sur le WS
- ~20 agents max → LRU simple, pas besoin de Redis
- Pas d'Ansible : l'agent Go existant sera étendu (actions `package.*`, `script.execute`)
- Agent Docker → renommé "Probe" (monitoring only). Agent systemd = agent complet
- Dashboard : redesign complet inspiré Cockpit/Landscape + thèmes couleur
- Librairie graphiques : Recharts (le plus pérenne, pas de conflit avec shadcn/ui)
- Seuils de santé : configurables via le modèle `Setting` existant
- Tests E2E obligatoires pour chaque phase
- Machines inactives : cycle STALE (7j) → ARCHIVED (30j) → supprimé (90j), configurable
- Processus : collecte toutes les 10 min + bouton pull à la demande
- OS cible : Ubuntu/Debian uniquement (VM + LXC)
- Webhooks : JSON générique signé HMAC-SHA256
- Email : Gmail SMTP via `nodemailer`
- Permissions tags : ADMIN only pour le moment
- Groupes dynamiques : tags + statut pour commencer

---

## PHASE 1 — Sécurité (Sprint 1)

> Objectif : fermer les 3 failles critiques identifiées.

### 1.1 Authentification WebSocket Dashboard

**Problème** : `/ws/dashboard` accepte toute connexion. Le token query param n'est jamais vérifié côté serveur.

**Implémentation** :

**`backend/src/websocket/server.ts`** — ajouter validation JWT dans le handler `upgrade` pour `/ws/dashboard` :
- Extraire le token depuis le header `Sec-WebSocket-Protocol`
- Supporter les deux modes auth :
  - Si `AUTH_MODE` inclut `keycloak` : tenter `verifyKeycloakToken()` (depuis `backend/src/services/keycloak.ts`)
  - Si `AUTH_MODE` inclut `local` : tenter `app.jwt.verify(token)`
- Si les deux échouent : `socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy()`
- Si succès : `dashboardWss.handleUpgrade()` avec le protocol `nexus-auth` dans la réponse

**`frontend/src/hooks/useWebSocket.tsx`** — changer le mode d'envoi du token :
- Remplacer `new WebSocket(url + '?token=' + token)` par `new WebSocket(url, ['nexus-auth', token])`
- Supprimer la construction de l'URL avec query param

**Fonctions existantes à réutiliser** :
- `verifyKeycloakToken()` dans `backend/src/services/keycloak.ts`
- `app.jwt.verify()` (plugin `@fastify/jwt` déjà configuré dans `backend/src/index.ts`)

### 1.2 TLS auto-signé

**Problème** : trafic HTTP clair. Application en réseau local uniquement.

**Implémentation** :

**`frontend/nginx-https.conf`** — *nouveau*, config nginx avec TLS :
- `listen 443 ssl`, `listen 80` avec redirect 301 → https
- `ssl_certificate /etc/nginx/certs/nexus.crt`, `ssl_certificate_key /etc/nginx/certs/nexus.key`
- `ssl_protocols TLSv1.2 TLSv1.3`
- Garder les mêmes blocs `location /api/` et `location /ws/` avec proxy

**`frontend/nginx-http.conf`** — *nouveau*, config nginx HTTP seul (fallback si TLS désactivé)
- Copie de la config actuelle inline dans le Dockerfile

**`frontend/docker-entrypoint.sh`** — *nouveau* :
- Si `TLS_ENABLED=true` ET pas de certs trouvés → générer auto-signé avec `openssl req -x509 -nodes -days 3650 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1`
- Si `TLS_ENABLED=true` ET certs présents → les utiliser
- Si `TLS_ENABLED=false` → config HTTP
- Copier la bonne config nginx et lancer nginx

**`frontend/Dockerfile`** — modifier :
- Installer `openssl` dans l'image Alpine
- Copier les deux configs nginx et l'entrypoint
- `ENTRYPOINT ["./docker-entrypoint.sh"]`

**`docker-compose.yml`** — modifier le service `frontend` :
- Ajouter port `${FRONTEND_TLS_PORT:-26033}:443`
- Ajouter volume `${TLS_CERT_DIR:-./certs}:/etc/nginx/certs`
- Ajouter env `TLS_ENABLED=${TLS_ENABLED:-true}`

### 1.3 Nonces LRU

**Problème** : `Set<string>` en mémoire perdu au restart.

**`backend/package.json`** — ajouter `lru-cache` (^11.0.0)

**`backend/src/services/security.ts`** — remplacer :
- `const recentNonces = new Set<string>()` → `const recentNonces = new LRUCache<string, true>({ max: 10000, ttl: 5 * 60 * 1000 })`
- Supprimer le `setInterval` de nettoyage
- Remplacer `recentNonces.has(nonce)` → `recentNonces.has(nonce)` (même API)
- Remplacer `recentNonces.add(nonce)` → `recentNonces.set(nonce, true)`
- 10 000 entrées suffit pour ~20 agents (1 msg/30s × 20 agents × 300s = 200 nonces actifs max)

### 1.4 Tests E2E Phase 1

**`backend/tests/e2e/websocket-auth.test.ts`** — *nouveau* :
- Test 1 : connexion WS dashboard SANS token → attendu : connexion refusée (401)
- Test 2 : connexion WS dashboard AVEC token valide → attendu : connexion acceptée
- Test 3 : connexion WS dashboard AVEC token expiré → attendu : connexion refusée
- Test 4 : vérification que les messages broadcast arrivent après auth

**`backend/tests/e2e/nonce-replay.test.ts`** — *nouveau* :
- Test : envoyer deux messages agent avec le même nonce → le second doit être rejeté

---

## PHASE 2 — Tags, Groupes & Machine Lifecycle (Sprint 2)

> Objectif : système de tags/groupes (fondation pour les profils) + cycle de vie machines inactives.

### 2.1 Schéma base de données

**`backend/prisma/schema.prisma`** — ajouter :

```prisma
model Tag {
  id        String       @id @default(cuid())
  name      String       @unique
  color     String       @default("#6366f1")
  createdAt DateTime     @default(now())
  machines  MachineTag[]
}

model MachineTag {
  id        String   @id @default(cuid())
  machineId String
  machine   Machine  @relation(fields: [machineId], references: [id], onDelete: Cascade)
  tagId     String
  tag       Tag      @relation(fields: [tagId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())
  @@unique([machineId, tagId])
  @@index([machineId])
  @@index([tagId])
}

model MachineGroup {
  id          String               @id @default(cuid())
  name        String               @unique
  description String?
  type        GroupType            @default(STATIC)
  filter      Json?
  createdAt   DateTime             @default(now())
  updatedAt   DateTime             @updatedAt
  members     MachineGroupMember[]
}

model MachineGroupMember {
  id        String       @id @default(cuid())
  groupId   String
  group     MachineGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  machineId String
  machine   Machine      @relation(fields: [machineId], references: [id], onDelete: Cascade)
  addedAt   DateTime     @default(now())
  @@unique([groupId, machineId])
}

enum GroupType { STATIC DYNAMIC }
```

**Modifier le modèle `Machine`** :
- Ajouter relations : `tags MachineTag[]`, `groupMembers MachineGroupMember[]`
- Ajouter champs : `rebootRequired Boolean @default(false)`, `archivedAt DateTime?`
- Ajouter au enum `MachineStatus` : `STALE`, `ARCHIVED`

**Modifier le modèle `User`** — ajouter relation `profiles Profile[]` (pour Phase 5)

Migration : `npx prisma migrate dev --name add-tags-groups-lifecycle`

### 2.2 Machine Lifecycle (cycle de vie)

**`backend/src/services/machine-lifecycle.ts`** — *nouveau* :
- `checkMachineLifecycle()` — exécuté en background task toutes les heures :
  - Machines OFFLINE depuis > `stale_after_days` (Setting, défaut 7) → passer en `STALE` + broadcast dashboard + audit log
  - Machines STALE depuis > `archive_after_days` (Setting, défaut 30) → passer en `ARCHIVED` + audit log
  - Machines ARCHIVED depuis > `delete_after_days` (Setting, défaut 90) → suppression + audit log
- Chaque transition envoie une notification webhook/email si configuré

**`backend/src/index.ts`** — ajouter le background task lifecycle (toutes les heures)

**Fonctions existantes à réutiliser** :
- `createAuditLog()` dans les routes existantes (pattern à extraire en service)
- `broadcastToDashboard()` dans `backend/src/websocket/dashboard.ts`

### 2.3 API Tags & Groupes

**`backend/src/routes/tags.ts`** — *nouveau* (ADMIN only via `requireAdmin`) :
- `GET /api/tags` — liste + count machines par tag
- `POST /api/tags` — créer `{ name, color }`
- `PUT /api/tags/:id` — modifier
- `DELETE /api/tags/:id` — supprimer (cascade)
- `POST /api/machines/:id/tags` — assigner `{ tagId }`
- `DELETE /api/machines/:id/tags/:tagId` — retirer

**`backend/src/routes/groups.ts`** — *nouveau* (ADMIN only) :
- `GET /api/groups` — liste + count membres
- `POST /api/groups` — créer `{ name, description, type, filter? }`
- `PUT /api/groups/:id` — modifier
- `DELETE /api/groups/:id` — supprimer
- `GET /api/groups/:id/machines` — résoudre les membres
  - STATIC : query directe `MachineGroupMember`
  - DYNAMIC : évaluer `filter` JSON contre les machines (filtres : `{ tags: string[], status: string[] }`)
- `POST /api/groups/:id/members` — ajouter (STATIC only)
- `DELETE /api/groups/:id/members/:machineId` — retirer (STATIC only)

**`backend/src/routes/machines.ts`** — modifier :
- Include `tags: { include: { tag: true } }` dans les queries Prisma
- Ajouter `GET /api/machines/:id/tags` — lister les tags d'une machine

**`backend/src/index.ts`** — importer et register `tagsRoutes` et `groupsRoutes`

### 2.4 Settings API (seuils configurables)

**`backend/src/routes/settings.ts`** — *nouveau* (ADMIN only) :
- `GET /api/settings` — toutes les clés
- `PUT /api/settings/:key` — mettre à jour une valeur
- Clés initiales à seed :
  - `health_threshold_cpu` : 90
  - `health_threshold_memory` : 85
  - `health_threshold_disk` : 80
  - `stale_after_days` : 7
  - `archive_after_days` : 30
  - `delete_after_days` : 90
  - `smtp_config` : `{ host: "", port: 587, user: "", pass: "", from: "" }`

### 2.5 Frontend Tags

**`frontend/src/types/index.ts`** — ajouter interfaces `Tag`, `MachineGroup`, `MachineGroupMember`

**`frontend/src/services/api.ts`** — ajouter méthodes CRUD tags/groupes/settings

**`frontend/src/pages/Tags.tsx`** — *nouveau* : page gestion des tags (liste, create dialog, color picker, delete)

**`frontend/src/components/MachineCard.tsx`** — afficher les tags comme badges colorés sous les capabilities

**`frontend/src/pages/MachineDetail.tsx`** — section tags (add/remove via popover)

**`frontend/src/components/Layout.tsx`** — ajouter "Tags" dans `navItems`

### 2.6 Tests E2E Phase 2

- CRUD tags (create, assign to machine, verify in machine list, delete cascade)
- CRUD groupes (static: add/remove members, dynamic: filter resolution)
- Machine lifecycle (simuler offline > 7j → vérifier transition STALE)
- Settings API (read/write, vérifier impact sur lifecycle)

---

## PHASE 3 — Dashboard Redesign + Recharts (Sprint 3)

> Objectif : redesign complet du dashboard inspiré Cockpit/Landscape, avec Recharts.

### 3.1 Recharts

**`frontend/package.json`** — ajouter `recharts` (^2.15.0)

**`frontend/src/components/MetricsChart.tsx`** — réécriture complète :
- Remplacer les sparklines SVG custom par des `AreaChart` Recharts
- Composants : `ResponsiveContainer`, `AreaChart`, `Area`, `XAxis`, `YAxis`, `Tooltip`, `CartesianGrid`
- Garder le sélecteur de plage (15m, 1h, 6h, 24h, 7d)
- Ajouter tooltips interactifs avec valeurs exactes au hover
- Thème cohérent avec le dark theme

### 3.2 Dashboard Redesign

**`frontend/src/pages/Dashboard.tsx`** — réécriture complète :

**Layout inspiré Cockpit** :
```
┌─────────────────────────────────────────────────────────┐
│  HEADER : "Dashboard" + filtres tags/groupes + actions  │
├───────────┬───────────┬───────────┬───────────┬─────────┤
│  Machines │  En ligne │ Hors ligne│  Alertes  │ Reboot  │
│   total   │  ██ 12    │  ██ 2     │  ██ 3     │  ██ 1   │
├───────────┴───────────┴───────────┴───────────┴─────────┤
│  SANTÉ FLOTTE        Score: 87%  ████████████░░ Sain    │
├─────────────────────┬───────────────────────────────────┤
│  CPU moyen : 34%    │  RAM moyenne : 62%                │
│  ████████░░░░░░░░   │  ██████████████░░░                │
│  Disk moyen : 45%   │  Réseau : 12 MB/s in / 3 MB/s out│
│  █████████░░░░░░░   │  ████████░░░░░░░░                 │
├─────────────────────┴───────────────────────────────────┤
│  TOP CONSUMERS (tabs: CPU | RAM | Disk)                 │
│  1. srv-db-01       ██████████████████ 89%              │
│  2. srv-web-03      ████████████████   78%              │
│  3. srv-app-02      ██████████████     72%              │
├─────────────────────────────────────────────────────────┤
│  TENDANCES (Recharts - 1h)                              │
│  CPU flotte ~~~~/\~~~  RAM flotte ~~~~~/~~~~            │
├─────────────────────────────────────────────────────────┤
│  MACHINES (grille filtrable par tags/status)            │
│  [card] [card] [card] [card] [card] ...                 │
└─────────────────────────────────────────────────────────┘
```

**Sections du nouveau dashboard** :
1. **Stats cards** (6-7) : Total, Online, Offline, Alertes critiques, Reboot pending, Updates available
2. **Fleet Health** : score configurable (seuils via Settings), barres moyennes CPU/RAM/Disk/Réseau
3. **Top Consumers** : tabs CPU/RAM/Disk, top 5 machines avec barre + lien vers détail
4. **Tendances flotte** : 2 mini Recharts (CPU + RAM moyens sur 1h)
5. **Machine Grid** : existant amélioré avec filtres tags/statut + badges tags

### 3.3 Fleet Summary API

**`backend/src/routes/fleet.ts`** — *nouveau* :
- `GET /api/fleet/summary` :
  - Agrège les dernières métriques de toutes les machines online
  - Retourne : `{ avgCpu, avgMemory, avgDisk, totalNetworkIn, totalNetworkOut, topCpu: Machine[], topMemory: Machine[], topDisk: Machine[], healthScore, machineCount, onlineCount, alertCount, rebootCount }`
- `GET /api/fleet/trends?range=1h` :
  - Métriques agrégées par buckets de 5 min
  - Retourne : `{ buckets: [{ timestamp, avgCpu, avgMemory }] }`

### 3.4 Thèmes couleur

**`frontend/src/contexts/ThemeContext.tsx`** — *nouveau* :
- Context React pour le thème
- Thèmes : `dark` (défaut, actuel), `light`, `blue` (inspiré Cockpit)
- Stocké dans `localStorage`
- Applique des classes CSS sur `<html>` (`theme-dark`, `theme-light`, `theme-blue`)

**`frontend/src/styles/themes.css`** — *nouveau* :
- Variables CSS par thème (couleurs primaires, backgrounds, bordures, textes)
- Le thème `dark` reprend les couleurs actuelles
- `light` et `blue` sont des variantes

**`frontend/src/components/Layout.tsx`** — ajouter sélecteur de thème dans le sidebar (icône palette)

### 3.5 Filtrage Dashboard

**`frontend/src/pages/Dashboard.tsx`** :
- Barre de filtres : multi-select tags (Radix) + select groupe + select statut
- Les filtres s'appliquent à : stats cards, fleet health, top consumers, machine grid
- URL params sync (ex: `/?tags=prod,web&status=ONLINE`) pour partageabilité

### 3.6 Tests E2E Phase 3

- Fleet summary API retourne les bonnes moyennes
- Dashboard charge et affiche les sections sans erreur
- Filtres tags fonctionnent (sélection → grille filtrée)
- Changement de thème persiste en localStorage

---

## PHASE 4 — Agent amélioré (Sprint 1, en parallèle de Phase 1)

> Objectif : nouveaux collecteurs + distinction Agent/Probe + agent systemd.

### 4.1 Probe vs Agent

**`docker-compose.yml`** — renommer le service `agent` → `probe` :
- Ajouter label `nexus.type=probe`
- Ajouter env `NEXUS_AGENT_TYPE=probe`

**`docker-compose.agent.yml`** — renommer en `docker-compose.probe.yml`

**`agent/internal/config/config.go`** — ajouter champ `AgentType` (default: `agent`, env: `NEXUS_AGENT_TYPE`)

**`agent/cmd/nexus-agent/main.go`** — si `AgentType == "probe"` :
- Ne pas enregistrer les actions dangereuses (`system.update`, `package.*`, `script.*`)
- Garder uniquement : `system.info`, `system.heartbeat`, `system.metrics`

**Backend** : ajouter champ `type` (`AGENT` | `PROBE`) au modèle `Machine` dans `schema.prisma`
- L'enrollment détecte le type depuis le payload
- L'UI affiche une icône différente (serveur vs sonde)

### 4.2 Agent systemd

**`agent/deploy/nexus-agent.service`** — *nouveau* :
```ini
[Unit]
Description=Nexus Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nexus
Group=nexus
ExecStart=/usr/local/bin/nexus-agent
EnvironmentFile=/etc/nexus/agent.env
Restart=always
RestartSec=10
LimitNOFILE=65535

# Sécurité
ProtectSystem=strict
ProtectHome=true
NoNewPrivileges=true
ReadOnlyPaths=/proc /sys /etc/os-release
ReadWritePaths=/opt/nexus/keys

[Install]
WantedBy=multi-user.target
```

**`agent/deploy/install.sh`** — *nouveau* :
- Créer user `nexus` (nologin)
- Copier le binaire dans `/usr/local/bin/`
- Créer `/etc/nexus/agent.env` avec les variables
- Créer `/opt/nexus/keys/` avec permissions
- Installer et enable le service systemd
- Usage : `curl -sL https://nexus-server/install.sh | sudo bash -s -- --server wss://... --token ... --machine-id ...`

### 4.3 Métriques réseau

**`agent/internal/collector/network.go`** — *nouveau* :
- `GetNetworkStats(procPath) → []NetworkInterface`
- Lire `/proc/net/dev`, parser chaque ligne (skip lo)
- Stocker les valeurs précédentes dans une variable package-level
- Calculer delta bytes/sec entre deux appels
- Struct : `{ Name, RxBytes, TxBytes, RxBytesPerSec, TxBytesPerSec, RxPackets, TxPackets }`

**Pas de filtrage d'interfaces** : l'agent envoie tout, le frontend peut filtrer.

### 4.4 Top processus

**`agent/internal/collector/processes.go`** — *nouveau* :
- `GetTopProcesses(procPath, count) → ProcessList`
- Deux modes :
  - **Périodique** (toutes les 10 min) : envoyé dans `metrics.report` avec le reste
  - **À la demande** : nouvelle action `system.processes` (capability: `monitoring`)
- Lire `/proc/[pid]/stat` pour CPU (utime+stime), `/proc/[pid]/status` pour VmRSS
- Deux lectures à 1s d'intervalle pour le delta CPU
- Top 10 par CPU + top 10 par RAM (dédupliqués)
- Struct : `{ PID, Name, CPUPercent, MemPercent, User, Command }`

**`agent/cmd/nexus-agent/main.go`** — modifier `runMetrics` :
- Compteur de cycles, tous les 10 cycles (10 min si interval=60s) inclure les processus
- Ou : intervalle processus séparé configurable (`NEXUS_PROCESS_INTERVAL`, défaut 600s)

**`agent/internal/actions/processes.go`** — *nouveau* :
- Action `system.processes` : collecte à la demande, retourne le top processus immédiatement

### 4.5 Détection reboot

**`agent/cmd/nexus-agent/main.go`** — modifier `sendHeartbeat` :
- Vérifier `/var/run/reboot-required` (Ubuntu/Debian)
- Ajouter `reboot_required: bool` au payload heartbeat

**Backend handler** : dans `backend/src/websocket/handler.ts`, à la réception du heartbeat, mettre à jour `machine.rebootRequired` en DB.

### 4.6 Nouvelles actions agent

**`agent/internal/actions/package_install.go`** — *nouveau* :
- Action `package.install` (capability: `packages`)
- Params : `{ packages: string[] }`
- Exécute `apt-get install -y <packages>`
- Retourne stdout/stderr + success

**`agent/internal/actions/package_remove.go`** — *nouveau* :
- Action `package.remove` (capability: `packages`)
- Exécute `apt-get remove -y <package>`

**`agent/internal/actions/package_list.go`** — *nouveau* (si pas existant) :
- Action `package.list` (capability: `packages`)
- Exécute `dpkg -l` ou `apt list --installed`

**`agent/internal/actions/script_execute.go`** — *nouveau* :
- Action `script.execute` (capability: `scripts`)
- Params : `{ script: string, timeout?: number }`
- Écrit le script dans un fichier temp, exécute avec timeout (défaut 30s), supprime
- Retourne stdout, stderr, exit code
- Validation : taille max 10 KB

### 4.7 Tests E2E Phase 4

- Agent systemd : install script crée le service et l'agent se connecte
- Probe mode : vérifier que les actions dangereuses sont refusées
- Network collector : vérifier que les interfaces apparaissent dans les métriques
- Process collector : vérifier top 10 retourné
- Reboot detection : créer `/var/run/reboot-required`, vérifier le heartbeat
- Actions package.install/script.execute : vérifier exécution et réponse

---

## PHASE 5 — Système de Profils (Sprint 4)

> Objectif : orchestration automatique type Landscape (upgrade, reboot, scripts, lifecycle).

### 5.1 Schéma

**`backend/prisma/schema.prisma`** :

```prisma
enum ProfileType { UPGRADE REBOOT SCRIPT PACKAGE LIFECYCLE }

model Profile {
  id          String             @id @default(cuid())
  name        String             @unique
  type        ProfileType
  description String?
  config      Json               // Structure dépend du type
  enabled     Boolean            @default(true)
  tagFilters  String[]           // Noms de tags pour résoudre les machines
  createdBy   String?
  creator     User?              @relation(fields: [createdBy], references: [id], onDelete: SetNull)
  executions  ProfileExecution[]
  createdAt   DateTime           @default(now())
  updatedAt   DateTime           @updatedAt
  @@index([enabled])
  @@index([type])
}

model ProfileExecution {
  id          String    @id @default(cuid())
  profileId   String
  profile     Profile   @relation(fields: [profileId], references: [id], onDelete: Cascade)
  machineId   String
  machine     Machine   @relation(fields: [machineId], references: [id], onDelete: Cascade)
  status      String    // PENDING, RUNNING, COMPLETED, FAILED, SKIPPED
  startedAt   DateTime  @default(now())
  completedAt DateTime?
  output      Json?
  @@index([profileId, startedAt])
  @@index([machineId])
}
```

**Config JSON par type** :
- `UPGRADE` : `{ schedule: "0 3 * * 0", securityOnly: false, deliveryWindowMinutes: 60 }`
- `REBOOT` : `{ days: ["sunday"], time: "04:00", randomWindowMinutes: 30 }`
- `SCRIPT` : `{ script: "#!/bin/bash\n...", runAs: "root", triggerCron: "0 * * * *", timeoutSeconds: 60 }`
- `PACKAGE` : `{ packages: ["nginx", "curl"], action: "install" }`
- `LIFECYCLE` : remplacé par le système 2.2 (machine-lifecycle.ts), pas de profil dédié

### 5.2 Backend

**`backend/src/routes/profiles.ts`** — *nouveau* :
- `GET /api/profiles` — liste (ADMIN)
- `POST /api/profiles` — créer (ADMIN)
- `PUT /api/profiles/:id` — modifier (ADMIN)
- `DELETE /api/profiles/:id` — supprimer (ADMIN)
- `GET /api/profiles/:id/executions` — historique (ADMIN)
- `POST /api/profiles/:id/execute` — trigger manuel (ADMIN)

**`backend/src/services/profile-engine.ts`** — *nouveau* :
- `initProfileScheduler()` : au démarrage, charger tous les profils enabled avec un cron
- Utiliser `node-cron` pour le scheduling
- `resolveProfileMachines(profile)` : query machines ayant les tags dans `tagFilters` + status ONLINE
- `executeProfile(profile, machines)` :
  - Pour chaque machine : créer `ProfileExecution(PENDING)`
  - Staggered delivery : randomiser le démarrage dans `deliveryWindowMinutes`
  - Dispatcher l'action correspondante via le WebSocket agent
  - Mettre à jour le statut (RUNNING → COMPLETED/FAILED)
  - Broadcast progression au dashboard
- Gestion du rattrapage : au démarrage, vérifier les profils qui auraient dû s'exécuter pendant le downtime (fenêtre de grâce 1h)

**`backend/src/index.ts`** — ajouter `initProfileScheduler()` dans les background tasks

### 5.3 Frontend

**`frontend/src/pages/Profiles.tsx`** — *nouveau* :
- Liste des profils avec type, état, tags associés, prochaine exécution
- Dialog création/édition avec formulaires dynamiques par type
- Historique d'exécutions avec statut par machine
- Bouton "Exécuter maintenant"

**`frontend/src/components/Layout.tsx`** — ajouter "Profils" dans `navItems`

### 5.4 Tests E2E Phase 5

- Créer un profil UPGRADE avec cron, vérifier qu'il s'exécute au bon moment
- Trigger manuel d'un profil SCRIPT, vérifier l'exécution sur l'agent
- Vérifier le staggered delivery (les machines ne démarrent pas toutes en même temps)
- Profil PACKAGE : vérifier que l'action package.install est dispatchée

---

## PHASE 6 — Visualisations avancées (Sprint 5)

> Objectif : exploiter toutes les données collectées dans l'UI.

### 6.1 Métriques réseau (affichage)

**`frontend/src/components/MetricsChart.tsx`** — ajouter 2 graphiques :
- "Network In" (bytes/sec, Recharts AreaChart bleu)
- "Network Out" (bytes/sec, Recharts AreaChart vert)
- Sélecteur d'interface si plusieurs interfaces

### 6.2 Liste des processus

**`frontend/src/components/ProcessList.tsx`** — *nouveau* :
- Table triable : PID, Nom, CPU%, MEM%, User, Commande
- Bouton "Rafraîchir" (dispatch action `system.processes` à la demande)
- Bouton "Kill" par processus (ADMIN only + dialog confirmation)
  - Dispatch action `process.kill` avec PID

**`frontend/src/pages/MachineDetail.tsx`** — ajouter tab/section "Processus"

**`agent/internal/actions/process_kill.go`** — *nouveau* :
- Action `process.kill` (capability: `scripts`)
- Params : `{ pid: number, signal?: string }`
- Exécute `kill -<signal> <pid>` (défaut SIGTERM)
- Validation : PID > 1 (ne pas tuer init)

### 6.3 Comparaison de machines

**`frontend/src/pages/Compare.tsx`** — *nouveau* :
- Dropdown multi-select (2-3 machines max)
- Recharts `LineChart` avec une `Line` par machine (couleurs différentes)
- Sélecteur de métrique (CPU, RAM, Disk, Load, Network)
- Sélecteur de plage temporelle

**`frontend/src/components/Layout.tsx`** — ajouter "Comparer" dans `navItems`

### 6.4 Tests E2E Phase 6

- Network charts affichent des données réelles
- ProcessList charge et affiche les processus
- Kill process envoie l'action et l'agent répond
- Compare page superpose correctement les métriques de 2 machines

---

## PHASE 7 — Notifications (Sprint 3, en parallèle de Phase 3)

> Objectif : alerter l'admin par webhook et email.

### 7.1 Webhook signé HMAC-SHA256

**`backend/src/services/webhook.ts`** — *nouveau* :
- `sendWebhook(url: string, payload: object, secret: string)` :
  - `X-Nexus-Signature: sha256=<HMAC du body avec le secret>`
  - `X-Nexus-Timestamp: <ISO timestamp>`
  - `Content-Type: application/json`
  - Timeout 5s, retry 1 fois
  - Payload : `{ event: "alert.fired"|"alert.resolved"|"machine.stale"|"machine.archived", data: {...}, timestamp }`

**`backend/src/services/alert-engine.ts`** — modifier `fireAlert` et `resolveAlert` :
- Si `rule.notifyWebhook` : appeler `sendWebhook()`
- Non-bloquant (fire and forget avec log d'erreur)

**`backend/src/routes/settings.ts`** — ajouter clé `webhook_secret` (généré automatiquement au premier accès)

### 7.2 Email Gmail SMTP

**`backend/package.json`** — ajouter `nodemailer` (^6.9.0)

**`backend/src/services/email.ts`** — *nouveau* :
- `sendAlertEmail(to: string, alert: AlertData)` :
  - Transport SMTP via config `Setting.smtp_config`
  - Template HTML simple : titre alerte, machine, sévérité, valeur, seuil, timestamp
  - Supporte Gmail (host: `smtp.gmail.com`, port: 587, secure: false, auth: user+app-password)

**`backend/src/services/alert-engine.ts`** — modifier :
- Si `rule.notifyEmail` : appeler `sendAlertEmail()`

**`frontend/src/pages/Settings.tsx`** — *nouveau* :
- Page de configuration SMTP (host, port, user, password, from)
- Bouton "Tester" (envoie un email de test)
- Config webhook (URL + secret affiché)

### 7.3 Tests E2E Phase 7

- Webhook : déclencher une alerte, vérifier que le POST arrive (mock server)
- Webhook signature : vérifier le HMAC
- Email : vérifier que nodemailer est appelé avec les bons paramètres (mock transport)

---

## Ordre d'exécution final

```
Sprint 1 (conversation 1) : Phase 1 (sécurité) + Phase 4 (agent Go)
  ├── Sécurité WS + TLS + Nonces (backend + frontend)
  ├── Agent : probe/agent split, systemd, network, processes, reboot, nouvelles actions
  └── Tests E2E des deux phases

Sprint 2 (conversation 2) : Phase 2 (tags, groupes, lifecycle, settings)
  ├── Schéma DB + migrations
  ├── API tags/groupes/settings/lifecycle
  ├── Frontend tags + lifecycle badges
  └── Tests E2E

Sprint 3 (conversation 3) : Phase 3 (dashboard redesign) + Phase 7 (notifications)
  ├── Recharts installation + migration MetricsChart
  ├── Dashboard redesign complet
  ├── Thèmes couleur
  ├── Webhooks signés + Email Gmail
  └── Tests E2E

Sprint 4 (conversation 4) : Phase 5 (profils)
  ├── Schéma + API + profile engine
  ├── Frontend profils
  └── Tests E2E

Sprint 5 (conversation 5) : Phase 6 (visualisations)
  ├── Network charts + Process list + Compare
  └── Tests E2E finaux
```

## Fichiers critiques (récapitulatif)

| Fichier | Phases |
|---------|--------|
| `backend/prisma/schema.prisma` | 2, 4, 5 |
| `backend/src/websocket/server.ts` | 1 |
| `backend/src/services/security.ts` | 1 |
| `backend/src/index.ts` | 2, 3, 5 |
| `frontend/src/pages/Dashboard.tsx` | 3 |
| `frontend/src/hooks/useWebSocket.tsx` | 1 |
| `frontend/src/components/MetricsChart.tsx` | 3, 6 |
| `frontend/src/components/Layout.tsx` | 2, 3, 5, 6 |
| `agent/cmd/nexus-agent/main.go` | 4 |
| `agent/internal/config/config.go` | 4 |
| `docker-compose.yml` | 1, 4 |

## Vérification (par phase)

Chaque phase inclut des tests E2E. Stratégie de test globale :
- **Framework** : Vitest pour le backend, Playwright ou Cypress pour le frontend
- **Agent** : tests Go natifs (`go test ./...`)
- **Intégration** : `docker compose up`, scénarios complets (enrollment → métriques → alertes → notifications)
- **Sécurité** : test de connexion WS sans auth, test de replay nonce, test de signature webhook
