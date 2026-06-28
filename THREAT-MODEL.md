# Nexus — Modèle de menace

> **Statut.** Premier artefact d'ouverture open source. Décrit le modèle de menace de
> Nexus tel qu'il est *réellement implémenté* (vérifié contre le code, branche `master`),
> pas une intention.
>
> **Comment lire ce document.** Le corps principal est pragmatique : ce qu'un opérateur
> doit comprendre et faire pour déployer Nexus en sécurité. Les encarts **« Pour
> l'auditeur »** descendent au niveau du fichier et de la fonction pour quiconque veut
> vérifier les affirmations. Lisez le corps ; ouvrez les encarts si vous évaluez.
>
> **Ce document est honnête par construction.** La section la plus importante n'est pas
> « ce qui est protégé » (§5) mais **« ce qui n'est PAS protégé » (§6)**. Un modèle de
> menace qui ne décrit que ses forces est une plaquette commerciale.

---

## 1. Vue d'ensemble & périmètre

Nexus est un plan de contrôle pour parc de serveurs Linux. Il a deux moitiés :

- **Le backend** (control plane) : une application web + API. Un opérateur s'y connecte
  via un navigateur, voit l'état des machines, et déclenche des actions (redémarrer un
  service, appliquer une règle pare-feu, installer un paquet, ajouter un utilisateur…).
- **L'agent** (`nexus-agent`) : un binaire Go installé sur chaque machine gérée. Il
  reçoit les actions du backend par WebSocket, les exécute, et renvoie l'état/les
  métriques.

Une action n'est pas un simple « lire un fichier » : ce sont des opérations **root**
(pare-feu, services systemd, paquets, utilisateurs, SSH, netplan). C'est tout l'objet du
produit, et c'est ce qui définit son modèle de menace.

**Dans le périmètre de ce document :**
- Le canal de confiance agent ↔ backend (enrôlement, runtime, mises à jour).
- Le confinement de ce que l'agent peut faire sur son hôte.
- La frontière web du backend (authz, entrées/sorties HTTP, WebSocket).

**Hors périmètre (traités ailleurs ou non gérés par Nexus) :**
- La sécurité de l'OS hôte sous l'agent (durcissement du noyau, sécurité physique).
- La sécurité du navigateur de l'opérateur et de son poste.
- La sécurité de l'infrastructure de déploiement (Docker, Traefik, PostgreSQL) au-delà
  des variables de configuration que Nexus impose.
- Le fournisseur d'identité externe (Keycloak), traité comme une dépendance de confiance.

---

## 2. Actifs protégés

Par ordre décroissant de gravité en cas de compromission :

1. **La capacité d'exécuter des actions root sur le parc.** C'est l'actif suprême. Qui
   peut émettre une `action.request` valide vers un agent contrôle la machine en root.
2. **L'identité de l'agent** (`agent.key`) : la clé ECDSA qui prouve « je suis l'agent
   de la machine X ». La voler permet d'usurper un agent.
3. **Les secrets de signature du backend** (`JWT_SECRET`, `ECDSA_MASTER_SECRET`) : ils
   forgent les jetons de session opérateur et signent les messages serveur→agent. Les
   casser permet de forger un rôle ADMIN ou des ordres d'agent.
4. **Les clés de confiance hors-ligne** : la clé serveur ECDSA (pinning à l'enrôlement),
   la clé minisign de release (auto-upgrade), la clé de signature de script. Ce sont les
   racines : les compromettre contourne respectivement le pinning, l'auto-upgrade signé,
   et `script.execute`.
5. **La confidentialité du canal** : les métriques, l'inventaire, et le contenu des
   actions en transit.
6. **L'intégrité de l'audit** : le journal des actions exécutées par l'agent.

---

## 3. Modèle d'attaquant

Nexus est conçu contre les attaquants suivants :

| Attaquant | Position | Ce qu'il veut |
|---|---|---|
| **Réseau on-path** | Entre l'agent et le backend (LAN, FAI, MITM TLS) | Voler le token d'enrôlement, injecter/rejouer des ordres, déclasser le protocole, intercepter le trafic |
| **Web non authentifié** | Atteint l'API/le dashboard depuis Internet | Contourner l'auth, CSWSH, SSRF, scraping `/metrics` |
| **Opérateur sous-privilégié** | Compte READONLY ou OPERATOR valide | Élever ses droits au-delà de son rôle (mutations, actions privilégiées, script) |
| **Voleur de fichier de clé** | A exfiltré `agent.key` *seul* (sans le reste du disque) | Réutiliser la clé sur une autre machine / hors contexte |
| **Backend poussant un binaire** | Le backend (ou un attaquant qui le pilote) déclenche un auto-upgrade | Pousser un binaire agent root non signé |

### Explicitement HORS du modèle d'attaquant

Ces attaquants existent ; Nexus **ne prétend pas** s'en défendre. Le dire est aussi
important que lister les défenses :

- **Un attaquant déjà root (ou utilisateur `nexus-agent`) sur l'hôte d'un agent.** Il est
  déjà au sommet de cette machine. Il peut re-dériver la clé, lire la mémoire de l'agent,
  etc. Il n'y a rien à protéger contre lui *sur cette machine* — il l'a déjà.
- **Un attaquant détenant un snapshot/backup disque complet** d'un hôte d'agent. Voir §6 :
  le chiffrement at-rest ne le couvre pas.
- **Un backend pleinement compromis vis-à-vis du parc.** Voir §4-A : un backend de
  confiance *peut* commander les agents — c'est le modèle, pas une faille. Ce qu'on
  protège, c'est l'auto-upgrade (signature hors-ligne) et l'intégrité de l'identité
  agent ; pas la capacité du backend à émettre des actions légitimes.
- **Des locataires mutuellement méfiants sur une même instance.** Voir §4-B : il n'y a
  pas d'isolation tenant. Ce n'est pas un attaquant qu'on repousse, c'est une
  configuration à ne pas faire.
- **Compromission de la chaîne d'approvisionnement** (le dépôt source, le CI, la toolchain
  Go) — hors périmètre de ce document.

---

## 4. Modèle de confiance — les deux affirmations centrales

Tout le reste découle de ces deux affirmations. Si vous ne retenez que deux choses de ce
document, ce sont celles-ci.

### A. Un agent enrollé = root sur son hôte

Un agent Nexus exécute des actions root (pare-feu, services, paquets, utilisateurs, SSH)
via un *privhelper* compilé et `sudo`. **Enrôler un agent sur une machine, c'est confier
cette machine à l'opérateur du backend.** Quiconque contrôle le backend peut, par
construction, agir en root sur toutes les machines enrollées.

**Ce n'est pas une faille — c'est la fonction du produit.** Un plan de contrôle qui
administre des serveurs *doit* pouvoir les administrer. Les conséquences pratiques :

- Le backend est un actif de la plus haute valeur. Traitez-le comme vous traiteriez un
  serveur de gestion de configuration (Ansible Tower, etc.) : accès restreint, durci,
  surveillé.
- N'enrôlez un agent que sur une machine que vous acceptez de confier à l'opérateur du
  backend.
- Le confinement de l'agent (§5) ne *réduit pas* ce pouvoir — il **borne la surface** :
  l'agent ne peut faire que les actions définies, par des chemins vérifiés, sans wildcard
  exploitable. Mais l'ensemble de ces actions reste, par nature, du contrôle root.

### B. Une instance Nexus = un seul domaine de confiance

Nexus n'a **aucune isolation par utilisateur ni par locataire.** L'autorisation est une
échelle RBAC globale unique (`ADMIN` > `OPERATOR` > `READONLY`). Il n'y a pas d'`ownerId`
ni de `projectId` sur les machines : **tout compte authentifié voit et — selon son rôle —
agit sur le parc entier.**

> ⚠️ **Ne déployez PAS une seule instance Nexus pour des équipes/clients qui ne se font
> pas mutuellement confiance.** N'importe quel OPERATOR peut agir sur n'importe quel hôte ;
> n'importe quel READONLY peut lire tous les hôtes. Pour des domaines de confiance
> distincts, faites tourner **des instances Nexus séparées.**

Conséquence (positive) de ce choix : il n'y a *pas* de frontière d'objet par utilisateur à
franchir, donc **pas d'« IDOR sur les machines »** — *par conception*. Le risque n'est pas
une élévation horizontale entre tenants ; c'est de croire à une isolation qui n'existe pas.

*(Référence : finding WEB-AUTHZ-006, déjà documenté dans le README.)*

---

## 5. Ce qui est protégé, et comment

Deux fondations : **(1) la racine de confiance du canal** agent↔backend, et **(2) le
confinement de l'agent** sur son hôte. Plus la **frontière web** du backend.

### 5.1 La racine de confiance — « authenticité garantie à chaque âge de la clé »

C'était l'axe central de l'audit interne : reconstruire la confiance aux quatre moments de
la vie de la clé d'identité — bootstrap, runtime, repos, et mise à jour.

#### Bootstrap (enrôlement) — pas de swap de clé on-path, pas de rejeu

Quand un agent s'enrôle, sa requête est **scellée** (chiffrement ECIES/ECDH P-256) vers la
**clé serveur pinnée** que l'opérateur a déployée hors-ligne avec l'agent. Un attaquant
on-path ne peut donc ni lire le token d'enrôlement, ni substituer sa propre clé : le
chiffrement est fait *contre la clé pinnée locale*, jamais contre une clé reçue du réseau.
La requête embarque un horodatage + un nonce liés à la preuve signée → un enrôlement
rejoué est rejeté.

> **Pour l'auditeur.** Seal : `agent/internal/security/seal.go:65-93` (ECDH éphémère P-256
> contre la clé pinnée, HKDF `nexus-enroll:<id>`, AES-256-GCM ; privée éphémère jamais
> persistée). Ouverture : `backend/src/services/enrollment-seal.ts:13-30`. La clé renvoyée
> par le serveur n'est utilisée que pour un *contrôle d'égalité* avec la pinnée, jamais
> comme base de dérivation : `agent/internal/security/enrollment.go:181-211`. Anti-replay :
> nonce+timestamp dans le payload scellé (`enrollment.go:64-99`), proof composite
> domain-separated `nexus-enroll-proof:v2:…` (`crypto.go:198-200`), nonce mémorisé seulement
> *après* preuve d'authenticité (`backend/src/services/enrollment.ts:131-159`).
> *Findings ENROLLMENT-001/002.*

Le **pinning est obligatoire**, sans repli silencieux : l'agent `log.Fatal` au boot si
aucune clé serveur n'est configurée ; `Enroll()` refuse sans elle ; `install-agent.sh`
exige `--server-public-key-file`.

> **Pour l'auditeur.** `agent/cmd/nexus-agent/main.go:211-215` (log.Fatal),
> `enrollment.go:108-110` (refus), `scripts/install-agent.sh:265-269` (flag requis).
> *Finding ENROLLMENT-003 (GUARD).*

#### Canal runtime — protocole v2 versionné, signé message par message

À chaque connexion, agent et backend exécutent un **handshake ECDHE X25519** (forward
secrecy : compromettre une clé long-terme ne déchiffre pas les sessions passées). Ensuite,
**chaque message authentifié est vérifié par signature**, avec un nonce anti-rejeu, et la
**version du protocole est liée dans la signature** (un attaquant ne peut pas déclasser
vers un protocole v1 plus faible).

> **Pour l'auditeur.** Handshake : `agent/internal/security/handshake.go:40-111`,
> `backend/src/services/session-handshake.ts:57-62` (clés éphémères X25519, jamais
> persistées). Vérif par-message : le backend revérifie *littéralement chaque* message
> authentifié contre la pubkey relue en DB (`backend/src/websocket/handler.ts:89-95`, pas
> de cache — finding CRYPTO-003). Côté agent, la signature serveur est vérifiée sur les
> messages déclenchant une action sensible (`action.request` `main.go:409-421`,
> `action.confirm` `main.go:433-445`) et sur l'ack du handshake ; `ping`/`error` ne sont pas
> signés mais ne déclenchent aucune action. Anti-rejeu : `server_verify.go:39-58` (nonce
> mémorisé après vérif, CRYPTO-005). Version en tête du payload signé :
> `crypto.go:184-191`, vérifiée d'abord (`server_verify.go:70-72`). *Findings
> CRYPTO-003/004/005.*

#### Repos — `agent.key` chiffré, lié à la machine

La clé d'identité est **chiffrée au repos** (AES-256-GCM) avec une clé dérivée du
`machine-id` de l'hôte + un sel d'installation. Une copie *isolée* du fichier de clé, sans
le contexte de la machine, est inutilisable ; recopiée sur une autre machine, elle ne
déchiffre pas.

> **Pour l'auditeur.** `agent/internal/security/keystore.go:53-102` (`wrappingKey()` =
> HKDF sur `/etc/machine-id` + sel `/etc/nexus/agent-keysalt`, fail-closed si machine-id
> vide ou sel < 16 octets ; format `nonce:ciphertext`, PEM clair jamais sur disque ;
> auto-migration legacy sans résidu clair `:187-231`). Sel généré à
> `install-agent.sh:668-672` (`root:nexus-agent 0640`). **Limite cruciale en §6.**
> *Finding CRYPTO-001.*

#### Sommet — auto-upgrade signé minisign, fail-closed

Une mise à jour de l'agent n'est installée que si le binaire est accompagné d'une
**signature minisign détachée**, vérifiée contre une clé de release **déployée hors-ligne
par l'opérateur** (jamais fournie par le backend). Signature manquante, invalide, ou clé
release absente ⇒ **refus** (fail-closed), avant toute installation. L'URL de
téléchargement est épinglée sur le backend enrôlé (anti-SSRF / anti-exfiltration du token).

> **Pour l'auditeur.** `agent/internal/actions/agent_upgrade.go` : clé locale
> `/etc/nexus/release.pub` (`:116,198-201`), refus si signature/clé absentes (`:198-213`),
> vérif AVANT install + suppression du staging si invalide (`:296-299`), pin du
> `download_url` sur l'hôte pinné avant envoi du bearer (`validateDownloadURL :33-49`,
> `:231-236`). Anti-rollback (`:215-229`), anti-TOCTOU re-hash avant install (`:317-324`).
> `LoadMinisignAcceptList` renvoie toujours une erreur plutôt qu'une liste vide
> (`minisign_verify.go:23-44`). *Findings SELF-UPGRADE-001 à 005.*

### 5.2 Le confinement de l'agent — borner la surface root

Le pouvoir de l'agent est root (affirmation A), mais sa *surface* est étroite et vérifiée.

- **Le process agent tourne dépouillé.** Utilisateur non-root `nexus-agent`, aucune
  *capability* ambiante, et `CAP_DAC_READ_SEARCH` + `CAP_SYS_PTRACE` retirées du bounding
  set de toute l'unité (on ne peut pas contourner les permissions de fichiers ni inspecter
  d'autres process). Durcissement systemd complémentaire : `ProtectHome`, `PrivateTmp`,
  `ProtectKernel*`, `RestrictRealtime`, `LockPersonality`, `RestrictAddressFamilies`…

> **Pour l'auditeur.** `scripts/install-agent.sh:707-784` (heredoc du `.service`) :
> `AmbientCapabilities=` vide (`:753`), `CapabilityBoundingSet=~CAP_DAC_READ_SEARCH
> CAP_SYS_PTRACE` (`:764`). *Nuance honnête : `~` est une **négation**, pas une allow-list*
> — le bounding set par défaut moins ces deux caps. Une allow-list plafonnerait aussi les
> enfants `sudo` (apt/netplan/useradd) et casserait les actions. `SystemCallFilter` est
> volontairement absent (sudo SUID nécessaire). Le confinement repose donc sur sudoers +
> `Protect*` ciblés, **pas** sur un sandbox seccomp. *Finding AGENT-002.*

- **Les mutations privilégiées passent par un privhelper compilé**, pas par des wildcards
  sudoers. Le drop-in `/etc/sudoers.d/nexus-agent` n'autorise pas `useradd *` ni
  `install …*/…` à destination arbitraire ; il appelle un binaire Go root-owned (pas
  d'interpréteur shell invocable) qui **valide ses entrées** : login POSIX strict, `--`
  qui termine le parsing d'options (`-o`/`-u 0` impossibles), sources résolues par
  `realpath` confinées au répertoire d'état agent, destinations fixes ou validées.

> **Pour l'auditeur.** Privhelper : `agent/internal/privhelper/privhelper.go` (useradd
> `:114-131`, install-* `:133-183` via `resolveUnderStaging :78-92` + `EvalSymlinks`, svc
> `:221-240`). Sudoers : `install-agent.sh:344-531` (`env_reset`+`secure_path` scopés
> `:356-357`, ligne privhelper `:408`, `NOEXEC:` sur apt/dnf `:379-392`, validé `visudo -cf`
> avant install atomique `:545-550`). *Nuance honnête : des wildcards d'**arguments**
> légitimes subsistent (`ufw allow *`, `apt-mark hold *`, `userdel -r *`, `cat
> /home/*/.ssh/authorized_keys`, `pvs -o *`) — aucun n'invoque d'interpréteur, mais ils ne
> sont pas argument-exacts ; et les `install` à **destination littérale** écrivent un
> contenu contrôlé par l'agent vers des chemins fixes (`/etc/fail2ban/jail.local`, etc.).*
> *Findings AGENT-001/003/006/008/009.*

- **`find` épinglé.** L'action `ssl.scan` énumère les certificats via un `find` à prédicat
  fixe (racines figées, `-maxdepth 4 -type f -name *.pem -o … *.crt`), byte-identique à la
  ligne sudoers — aucun `-exec` injectable.

> **Pour l'auditeur.** `agent/internal/actions/ssl_scan.go:111-124`, identique à
> `install-agent.sh:487`. *Finding AGENT-001.*

- **`script.execute` est opt-in, désactivé par défaut, derrière trois verrous
  indépendants** (chacun bloque seul) : (a) la ligne sudoers `nexus-script` n'est écrite
  qu'avec `--allow-remote-script` à l'install ; (b) le backend refuse au dispatch sans
  `ALLOW_REMOTE_SCRIPT=true` ; (c) l'agent vérifie une signature minisign détachée du
  script (`script_sig`) avant toute écriture/exécution. Et `script.execute` est
  **ADMIN-only**.

> **Pour l'auditeur.** (a) `install-agent.sh:534-540` ; (b)
> `backend/src/services/privileged-actions.ts:39-61` + dispatch central
> `action-dispatcher.ts:67-70` ; (c) `agent/internal/actions/script_execute.go:44-61` +
> `minisign_verify.go:23-44` (fail-closed). ADMIN-only : `ADMIN_ONLY_ACTIONS =
> {"script.execute", "process.kill"}` (`privileged-actions.ts:29`). **`process.kill` est
> lui aussi ADMIN-only** : c'est une primitive *destructrice à impact arbitraire* (tuer
> n'importe quel PID = DoS/perte de données du workload, sans reprise supervisée), et sa
> seule protection runtime est une **denylist de services critiques (incomplète par
> nature** : un workload non listé — DB custom, broker, app métier, autre reverse-proxy —
> est tuable sans garde). Le gate ADMIN couvre ce résiduel. C'est cohérent avec
> `script.execute`, l'autre membre du bucket `ALLOW_REMOTE_SCRIPT` : les deux primitives
> root à impact arbitraire exigent le même rôle. Rappel : `process.kill` refuse en plus son
> propre PID et celui des services critiques résolus en live (§ auto-protection).
> *Findings AGENT-004/005.*

- **L'agent ne peut pas se saboter lui-même.** Stop/restart du service `nexus-agent`
  refusés ; `process.kill` refuse son propre PID et le MainPID (résolu en live) des
  services critiques (ssh, docker, postgres, nginx, containerd…). Défense en profondeur
  sur 3 couches (action Go, privhelper, garde kill).

> **Pour l'auditeur.** `agent/internal/actions/services.go:23-154`,
> `privhelper.go:45-49,234-238`, `process_kill.go:33-43,74-76,109-111`. *Nuance : la garde
> kill protège une **liste** de services critiques résolus en live ; un service critique
> hors liste (autre reverse-proxy que nginx, p. ex.) n'est pas couvert.*

### 5.3 La frontière web du backend

- **L'autorisation est autoritaire côté serveur**, sur *tous* les chemins de dispatch
  (sync, async, bulk, batch). Le frontend (et les *feature flags* exposés par
  `/api/auth/config`) est **purement indicatif** — jamais l'autorité.

  > **Invariant pour les contributeurs.** Le RBAC distingue deux mondes au point de
  > dispatch : un appel portant un `userRole` (requête d'un opérateur authentifié, soumis à
  > l'échelle ADMIN/OPERATOR/READONLY) et un appel **sans rôle** (`userRole === undefined`),
  > traité comme un appel **système interne de confiance** qui contourne le RBAC (utilisé
  > par l'alert-engine, l'auto-upgrade…). **Toute la sûreté du RBAC repose sur cet
  > invariant : aucun chemin atteignable par un utilisateur ne doit appeler `dispatchAction`
  > sans rôle.** Il tient aujourd'hui parce que tout JWT émis porte un rôle et que chaque
  > route HTTP propage `user.role`. *Si vous ajoutez un point d'entrée vers `dispatchAction`,
  > il DOIT passer le rôle de l'appelant — sinon vous ouvrez un contournement complet du
  > RBAC.* Les actions privilégiées (§ ci-dessous) sont volontairement fail-closed même pour
  > `undefined`, mais le reste des mutations ne l'est pas.

> **Pour l'auditeur.** `dispatchAction()` applique en tête, avant toute I/O :
> `checkRoleForAction` (READONLY borné à `READ_ONLY_ACTIONS`, OPERATOR mutations, ADMIN
> `script.execute`/`process.kill`), `checkPrivilegedAction`, `checkRemoteScriptAction`,
> `checkCriticalProtection` — `backend/src/services/action-dispatcher.ts:39-90`. Tous les
> appelants passent le rôle (`routes/actions.ts`, `routes/bulk.ts`, `routes/security.ts`).
> Le bypass `userRole === undefined` est en `privileged-actions.ts:78-79`. Flags indicatifs
> documentés `routes/auth.ts:31-38`. *Findings WEB-AUTHZ-004/007.*

- **Anti-CSWSH sur le WebSocket dashboard.** L'Origin est validée en exact-match contre
  `FRONTEND_URL` ; origine inconnue ⇒ rejet (fail-closed).

> **Pour l'auditeur.** `backend/src/websocket/server.ts:230-235`. *Nuance honnête : le
> WebSocket **agent** (`/ws/agent`) n'a, lui, **pas** de contrôle d'Origin — c'est
> intentionnel : un agent est un client non-navigateur sans Origin, authentifié par
> handshake/signature, pas par Origin (`server.ts:111-115,202-214`). CSWSH est une menace
> navigateur ; elle ne s'applique qu'au dashboard.* *Finding CONTROL-PLANE-001.*

- **Garde SSRF sur tout le trafic HTTP sortant.** Toute URL sortante passe par
  `assertSafeOutboundUrl` + `safeFetch` : schéma http/https uniquement, refus des
  credentials embarqués, **blocage des cibles en réseau privé** (10/8, 172.16/12,
  192.168/16, 169.254/16, loopback, CGNAT…), refus des redirections, et **blocage
  synchrone des IP littérales** (le correctif qui ferme le contournement undici, lequel
  saute le hook DNS pour un littéral). Anti-rebinding par épinglage de l'adresse résolue.

> **Pour l'auditeur.** `backend/src/services/net-guard.ts:28-166`. Call-sites tous gardés :
> webhook (`webhook.ts:30,47,71`), notifications (`notifications.ts:353,357`), nautilus
> (`nautilus-integration.ts:148,159`), apt-catalog (`apt-catalog.ts:89,90`). **Hors
> périmètre du guard (cf. §6) : `keycloak.ts` (JWKS, URL issue de l'env admin
> `KEYCLOAK_URL`) et `email.ts` (SMTP, non-HTTP, host issu d'un setting admin-only).**
> *Finding WEB-AUTHZ-001.*

- **`/metrics` fermé.** Si `METRICS_TOKEN` est défini, l'accès exige un `Bearer` (comparé
  en temps constant) ; token absent/faux ⇒ 401. *Additif* au scoping réseau.

> **Pour l'auditeur.** `backend/src/services/prometheus.ts:204-220`. *Nuance : sans
> `METRICS_TOKEN`, l'endpoint repose entièrement sur le scoping réseau — voir §7.* *Finding
> WEB-AUTHZ-005.*

- **Anti-mass-assignment.** Le `PUT` d'une règle d'alerte n'accepte que des champs
  explicitement listés (schéma `additionalProperties:false` + allow-list, jamais de spread
  du body), et est ADMIN-only.

> **Pour l'auditeur.** `backend/src/routes/alerts.ts:145-203`. *Finding WEB-AUTHZ-003.*

- **Actions de privilège utilisateur verrouillées.** `sshkey.add/remove`,
  `user.update_sudo`, et `user.create` avec `sudo:true` créent un accès qui *survit à la
  désinstallation de l'agent* (non révocable par Nexus). Elles sont **désactivées par
  défaut** (`ALLOW_USER_PRIVILEGE_MGMT=true` pour activer) **et ADMIN-only**, gatées
  centralement dans le dispatch (couvre sync/async/bulk/batch). Les lectures
  (`user.list`/`sshkey.list`) restent ouvertes.

> **Pour l'auditeur.** `backend/src/services/privileged-actions.ts:16-159` (double verrou
> flag + ADMIN), gate `action-dispatcher.ts:55-62`. La variante `user.create{sudo:true}`
> est bien traitée comme privilégiée (`:123-130`).

---

## 6. Ce qui n'est PAS protégé — limites assumées

**C'est la section la plus importante de ce document.** Chaque limite ci-dessous est réelle
et assumée. Les lire, c'est savoir ce que Nexus *ne* fait *pas* pour vous.

### 6.1 Vol d'un disque / snapshot / backup complet

Le chiffrement at-rest d'`agent.key` (§5.1) protège une copie *isolée* du fichier de clé.
Il **ne protège PAS un snapshot ou un backup disque complet** de l'hôte d'un agent. Le
`machine-id` et le sel voyagent *avec le disque* : un attaquant détenant une image complète
re-dérive la clé d'habillage et déchiffre `agent.key`.

**Concrètement** : un snapshot Proxmox, un backup PBS, ou tout backup pleine-image d'un
hôte d'agent **contient l'identité de cet agent**. Traitez ces backups comme des secrets.

Seul un scellement matériel **TPM 2.0** (clé non-exportable) fermerait ce cas — **non
implémenté** (roadmap, opt-in matériel : DEF-1). *(Finding RB-4 / CRYPTO-001.)*

### 6.2 Pas d'isolation entre locataires

Rappel de l'affirmation B (§4) : une instance = un domaine de confiance unique. Tout
OPERATOR agit sur tout l'hôte, tout READONLY lit tout l'hôte. **Ce n'est pas une faille
réparable par configuration** — c'est le modèle. Pour des locataires méfiants : instances
séparées.

### 6.3 La garde anti-SSRF bloque le réseau privé par défaut

C'est une protection, mais elle a une **conséquence opérationnelle à connaître** pour ne
pas la prendre pour un bug : par défaut, le guard bloque toute notification/sortie HTTP
vers une cible en réseau privé (10.x / 172.16.x / 192.168.x / 169.254.x / loopback).

- Notifier un service **externe** (Discord, Slack, un webhook public) fonctionne sans
  configuration.
- Notifier un service **interne auto-hébergé** (ntfy / Gotify / un webhook sur le LAN,
  un miroir APT en 10.x) **échouera** tant qu'une **allow-list opérateur** n'existe pas.
  Cette allow-list **n'est pas encore implémentée** (tête de roadmap post-v1). Les
  métadonnées cloud (169.254.169.254) ne seront jamais allow-listables.

À dire explicitement : si votre notification interne « ne part pas », ce n'est pas une
panne — c'est le guard SSRF qui fait son travail.

### 6.4 Sorties non couvertes par la garde SSRF : Keycloak (JWKS) et SMTP

Deux canaux sortants ne passent **pas** par la garde anti-SSRF, parce qu'ils ne sont pas du
trafic HTTP-vers-URL-contrôlable-par-un-attaquant :

- **`KEYCLOAK_URL`** (récupération JWKS) : URL fixée par l'opérateur dans l'environnement,
  même classe de confiance que `DATABASE_URL`. Pas d'entrée runtime attaquant-contrôlable.
- **Relais SMTP** (`email.ts`) : egress SMTP (non-HTTP, donc hors du guard HTTP), host issu
  d'un setting **ADMIN-only**. Un relais interne est souvent légitime.

Ce ne sont **pas** des trous SSRF exploitables au runtime par un attaquant non privilégié.
Ils sont signalés par honnêteté : un *administrateur* qui écrit ces réglages peut pointer
vers un host interne (mais un admin a déjà bien d'autres pouvoirs). Un guard JWKS/SMTP est
une décision ultérieure, pas un correctif urgent.

### 6.5 Backend compromis : peut commander, l'audit n'est pas WORM

Un backend de confiance *peut* émettre des actions root (affirmation A). Si le backend est
compromis, l'attaquant hérite de ce pouvoir. Deux nuances :

- L'auto-upgrade reste protégé (le backend ne peut pas pousser un binaire non signé — §5.1).
- L'audit côté agent (journald, append-only) est *tamper-evident* vis-à-vis de l'agent,
  mais **un puits WORM externe (write-once) n'est pas en place.** Un attaquant avec un
  pouvoir suffisant sur l'hôte de log pourrait, à terme, altérer l'historique. Exporter
  les logs vers un sink immuable externe relève de l'opérateur.

### 6.6 Attaquant déjà root sur l'hôte d'un agent

Hors périmètre (rappel §3) : il est déjà au sommet de cette machine. Le confinement de
l'agent borne ce que *Nexus* fait faire à l'agent ; il ne défend pas une machine déjà
tombée.

---

## 7. Responsabilités de l'opérateur

Le modèle ci-dessus **ne tient que si** les conditions suivantes sont vraies au
déploiement. Ce sont *vos* responsabilités ; Nexus ne peut pas les garantir à votre place.

### 7.1 Générer des secrets FORTS — jamais les valeurs par défaut

`JWT_SECRET`, `ECDSA_MASTER_SECRET` (et `METRICS_TOKEN` si vous l'activez) doivent être
forts et uniques. Les casser permet de forger un rôle ADMIN ou des ordres d'agent (§2).

- `openssl rand -hex 32` (≈ 256 bits) au minimum, par secret, distincts entre eux.
- Nexus **refuse de démarrer** (échec bruyant au boot, finding CONTROL-PLANE-005) si
  `JWT_SECRET`/`ECDSA_MASTER_SECRET` sont : absents, de moins de 32 caractères, une valeur
  *placeholder* connue (`changeme`, `secret`, `password`, `default`, `example`… — y compris
  répétée/paddée pour atteindre 32 car., type `changeme_changeme_changeme_changeme`), ou à
  entropie nulle (un seul caractère répété). `METRICS_TOKEN` est optionnel, mais **s'il est
  défini** il est soumis aux mêmes contrôles (fatal si faible).

> **Pourquoi cette garde.** La longueur seule ne suffit pas : un placeholder copié de la
> doc franchit 32 caractères tout en restant deviné d'avance. Même principe que la garde
> `wss://` obligatoire — un défaut qui casse la sécurité en silence est pire qu'un échec
> bruyant. Détail : un secret fort qui *contient* par hasard un mot-placeholder (avec de
> l'entropie autour) reste accepté ; seuls les secrets *composés uniquement* de placeholders
> sont rejetés.

### 7.2 Provisionner les clés de confiance HORS-LIGNE

Les trois racines de confiance doivent être générées et déployées **hors-ligne**, jamais
via l'UI — pour qu'un backend compromis ne puisse pas se les attribuer :

- **Clé serveur ECDSA** (pinning à l'enrôlement) → `--server-public-key-file`.
- **Clé minisign de release** (auto-upgrade) → `/etc/nexus/release.pub`.
- **Clé de signature de script** (`script.execute`) → `/etc/nexus/script-signing.pub`.

*(Une doc dédiée « génération de clés opérateur » accompagne la publication.)*

### 7.3 Déployer en `wss://` (transport chiffré)

L'agent **refuse** un transport en clair (`ws://`/`http://`) sans override dev explicite —
garde déjà en place (échec bruyant à l'install et au runtime). Ne contournez pas cette
garde en production : `ws://` rouvrirait précisément le vol de token + swap de clé que le
seal d'enrôlement ferme.

### 7.4 Configurer les variables REQUISES (checklist)

Un défaut « sûr pour le dev local » casse souvent en **silence** en production. Checklist
minimale (défaut absent/local ⇒ doit produire un échec ou un warning visible) :

- [ ] `JWT_SECRET` — ≥ 32 car., unique (échec fatal au boot si faible).
- [ ] `ECDSA_MASTER_SECRET` — ≥ 32 car., distinct de `JWT_SECRET` (échec fatal au boot).
- [ ] `DATABASE_URL` — échec fatal si absent.
- [ ] `AGENT_BACKEND_URL` — `https://<domaine>` ; en `http://`, l'agent refuse (bruyant).
- [ ] `FRONTEND_URL` — `https://<domaine>` exact (sans `/` final, sans `:443`) ; warning au
      boot si local. Gouverne CORS + l'allow-list d'Origin CSWSH (§5.3) : un mauvais réglage
      fait rejeter le vrai domaine en boucle.
- [ ] `TRUSTED_PROXY_HOPS` — cohérent avec votre chaîne de proxies (sinon l'IP réelle des
      agents est mal résolue).
- [ ] `METRICS_TOKEN` — défini si `/metrics` est atteignable au-delà du scraper de
      confiance (sinon l'endpoint repose sur le seul scoping réseau).
- [ ] `TLS_ENABLED=false` si un reverse-proxy (Traefik) termine le TLS (sinon double-TLS /
      cert auto-signé que l'agent refuse).

### 7.5 Comprendre ce que vous acceptez

- Chaque agent enrollé = une machine confiée à l'opérateur du backend (§4-A).
- Une instance = un domaine de confiance ; pas pour des locataires méfiants (§4-B).
- Les backups/snapshots complets d'un hôte d'agent contiennent son identité (§6.1).
- Traitez le backend comme l'actif le plus sensible de votre parc.

---

## Annexe A — Pour les évaluateurs : correspondance findings ↔ code

| Domaine | Findings | Verdict (vérifié sur `master`) |
|---|---|---|
| Bootstrap scellé + anti-replay | ENROLLMENT-001/002/003 | Confirmé |
| Canal v2 (ECDHE, par-message, anti-downgrade) | CRYPTO-003/004/005 | Confirmé (agent : signature sur messages sensibles + ack ; `ping`/`error` inertes non signés) |
| `agent.key` at-rest | CRYPTO-001 | Confirmé — **ne couvre pas le snapshot complet (§6.1)** |
| Auto-upgrade minisign fail-closed | SELF-UPGRADE-001→005 | Confirmé |
| Bounding set / Ambient | AGENT-002 | Confirmé (négation, pas allow-list ; pas de seccomp) |
| Sudoers + privhelper + find épinglé | AGENT-001/003/006/008/009 | Confirmé (wildcards d'args bénins subsistants documentés) |
| `script.execute` 3 verrous + ADMIN-only | AGENT-004/005 | Confirmé (`process.kill` désormais ADMIN-only lui aussi — primitive destructrice à denylist incomplète) |
| RBAC autoritaire serveur | WEB-AUTHZ-004/007 | Confirmé |
| CSWSH Origin | CONTROL-PLANE-001 | Confirmé **pour le dashboard** ; agent WS exempt par design |
| SSRF egress guard (+ IP littérale) | WEB-AUTHZ-001 | Confirmé ; **Keycloak/SMTP hors-périmètre (§6.4)** |
| `/metrics` authentifié | WEB-AUTHZ-005 | Confirmé (sans token → scoping réseau seul) |
| Anti-mass-assignment | WEB-AUTHZ-003 | Confirmé |
| Privilèges utilisateur off-by-default + ADMIN | (privileged-actions) | Confirmé |
| No tenant isolation | WEB-AUTHZ-006 | Confirmé — limite assumée (§6.2) |

Limites/différés connus : at-rest snapshot (DEF-1 / TPM), allow-list SSRF interne (post-v1),
rotation de clé automatique (CRYPTO-002, couverte aujourd'hui par le re-enroll manuel),
signatures DER bout-en-bout (CRYPTO-007, hygiène, déploiement v2), audit WORM externe (§6.5).

Au-delà des tests automatisés (suite e2e + unitaires Go + vecteurs d'interop Go↔Node), les
propriétés qui exigent un host/réseau/parc réels (bounding set sous systemd, flux v2 complet
enroll→handshake→heartbeat, sudoers durci, scoping `/metrics`, garde SSRF en réseau réel…)
ont été vérifiées en conditions réelles sur un environnement de staging — 12 points de
contrôle couverts. Le présent document se suffit à lui-même ; ces vérifications de
déploiement sont conservées hors de ce dépôt.
