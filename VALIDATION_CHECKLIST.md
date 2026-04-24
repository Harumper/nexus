# Checklist de validation manuelle — Phase A

À exécuter sur une VM réelle après déploiement en prod.

## Prérequis

- [ ] Pipeline CI vert sur commit `HEAD`
- [ ] `deploy-prod` manuel exécuté sur GitLab
- [ ] Au moins une VM Ubuntu 22.04 ou 24.04 ré-enrôlée en AGENT

## Tier 0 (features déjà en prod)

### Services systemd
- [ ] Onglet **Système → Services** affiche la liste
- [ ] Bouton "Voir les logs" ouvre le drawer avec journalctl
- [ ] Restart d'un service non-critique (ex: `cron`) fonctionne
- [ ] Protection : impossible de stopper `nexus-agent`

### Firewall ufw
- [ ] Onglet **Réseau → Pare-feu** affiche status + règles
- [ ] Ajout d'une règle "allow 9999/tcp" → toast countdown 60s
- [ ] Ne pas confirmer → la règle disparaît après 60s (revert)
- [ ] Redémarrer l'agent pendant la fenêtre de 60s → au reboot, règle revertie (dead man's switch)

### Paquets APT
- [ ] Onglet **Logiciels → Paquets** recherche fonctionnelle (FTS)
- [ ] Install d'un paquet (ex: `htop`) fonctionne
- [ ] Remove du même paquet fonctionne

## Tier 1

### Stockage
- [ ] Onglet **Monitoring → Stockage** affiche filesystems, block devices, LVM
- [ ] Sur une VM avec LVM → les cards PV/VG/LV apparaissent
- [ ] Sur une VM sans LVM → section "LVM non utilisé"

### Tâches (cron + timers)
- [ ] Onglet **Système → Tâches** tab "Timers" liste les timers systemd
- [ ] Tab "Cron" liste /etc/crontab et /etc/cron.d/*
- [ ] Enable/disable d'un timer fonctionne (ex: `apt-daily.timer`)

### Utilisateurs + SSH keys
- [ ] Onglet **Système → Utilisateurs** liste les users UID>=1000 + root
- [ ] Création d'un user test avec gecos fonctionne
- [ ] Ajout d'une clé SSH sur un user → visible dans le drawer
- [ ] Suppression de la clé SSH par fingerprint fonctionne
- [ ] Suppression du user test fonctionne
- [ ] Impossible de supprimer `root` ou `nexus-agent`

### Netplan
- [ ] Onglet **Réseau → Netplan** affiche le YAML de `/etc/netplan/`
- [ ] **⚠️ Ne pas tester en prod sur une VM distante critique**
- [ ] Sur VM test : modifier le YAML avec un changement mineur (ex: ajouter un commentaire) → Apply → countdown 120s → Confirmer avant timeout
- [ ] Test dead man's switch : Apply → redémarrer l'agent pendant la fenêtre → au reboot, revert

## Phase B (nouveautés)

### B1 — Bulk actions
- [ ] Page Machines : checkboxes apparaissent sur les cards
- [ ] Bouton "Tout" sélectionne les machines visibles
- [ ] Sélection de 2+ machines → bouton "Action groupée (N)" apparaît
- [ ] Clic → dialog avec choix d'action
- [ ] Action **system.update** sur 2 machines en ligne : résultats OK/Échec par machine
- [ ] Action **system.reboot** : nécessite de taper `REBOOT` pour confirmer
- [ ] Actions destructives (reboot, package.remove) en bouton rouge

### B2 — SSL cert tracking
- [ ] Sur une machine avec letsencrypt : Vue d'ensemble → carte "Certificats SSL" → Scanner → liste les certs avec days_remaining
- [ ] Sur une machine sans certs : message "Aucun cert détecté"
- [ ] Créer une règle d'alerte `CERT_EXPIRING` threshold 365 jours (pour trigger) → alert FIRING après 30s
- [ ] Baisser threshold à 1 → alert RESOLVED

### B4 — Alerting étendu
- [ ] Page Alertes → Nouvelle règle → Select groupé (Métriques / Connexion / Santé système)
- [ ] Créer `SERVICE_FAILED` sans targetPattern → si un service échoue → alert
- [ ] Créer `UPDATES_AVAILABLE` threshold 0 → alert si des updates dispos
- [ ] Vérifier les webhooks/emails reçus (si SMTP configuré)

### F1 — Package pinning
- [ ] Onglet **Logiciels → Mises à jour** → liste paquets upgradables
- [ ] Colonne "Hold" avec icône cadenas
- [ ] Clic sur cadenas ouvert → paquet passé en "held" (apacity 50%)
- [ ] Clic sur cadenas fermé → retour normal
- [ ] Vérifier via SSH : `apt-mark showhold` liste bien le paquet

### SSH button
- [ ] Header machine → bouton **SSH** → dialog avec commande pré-remplie
- [ ] Bouton "Copier" copie dans le clipboard
- [ ] Bouton "Ouvrir dans le terminal" tente `ssh://` (peut ne rien faire si pas de handler configuré)
- [ ] Lien vers Docs → Configuration SSH ouvre la bonne section

## Smoke tests cross-features

- [ ] Créer une machine PROBE → onglets Services/Firewall/Netplan/Users absents
- [ ] Créer une machine AGENT → tous les onglets présents
- [ ] Ajouter Paramètres → SSH user "root" → le dialog SSH pré-remplit `ssh root@ip`

## Self-monitoring

- [ ] Installer l'agent sur le serveur Nexus lui-même (cf. Docs → Self-monitoring)
- [ ] La machine `nexus-server` apparaît ONLINE
- [ ] Ses métriques correspondent à l'hôte (pas au container)

## Distros à couvrir

- [ ] **Ubuntu 22.04 LTS**
- [ ] **Ubuntu 24.04 LTS**
- [ ] **Debian 12** (netplan peut être absent, firewall ufw peut nécessiter install)

## Notes

- Les tests e2e automatisés (vitest) ne valident que la présence des fichiers + patterns. Cette checklist est LE validation test réel.
- Ce fichier peut être supprimé une fois la validation passée, ou converti en CI test avec VMs éphémères (Phase A v2).
