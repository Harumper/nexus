# Security Policy

Merci de contribuer à la sécurité de Nexus. Ce document explique **comment signaler une
vulnérabilité**, **ce qui entre dans le périmètre**, et **comment nous traitons les
signalements**.

Nexus est un plan de contrôle qui administre des serveurs en root : sa sécurité est prise au
sérieux. Le présent document est le pendant du [modèle de menace](THREAT-MODEL.md) —
celui-là décrit *ce qui est protégé et ce qui ne l'est pas* ; celui-ci décrit *comment
signaler quand quelque chose ne tient pas*.

## 1. Signaler une vulnérabilité

**Ne créez jamais d'issue publique pour une vulnérabilité de sécurité.** Une issue publique
expose le problème avant qu'un correctif n'existe.

Utilisez le canal **privé** de GitHub : le signalement privé de vulnérabilité (*Private
Vulnerability Reporting* / *Security advisories*), via l'onglet **Security → Report a
vulnerability** du dépôt. Il garde l'échange privé et tracé, et chiffre la communication.

> *Note au mainteneur : ce canal doit être **activé** dans les réglages du dépôt
> (**Settings → Security → Private vulnerability reporting**). Tant qu'il ne l'est pas, le
> bouton « Report a vulnerability » n'apparaît pas pour les rapporteurs.*

### Ce qu'un bon rapport contient

Pour que nous puissions reproduire et corriger vite :

- **Version / commit** concerné (sortie de `git rev-parse HEAD`, ou le tag de release).
- **Étapes de reproduction** précises.
- **Impact** : ce qu'un attaquant obtient — quel actif du [modèle de menace](THREAT-MODEL.md)
  (§2) est touché, quelle hypothèse de confiance est brisée.
- **Preuve de concept** minimale si possible.
- L'environnement utile (OS de l'agent, mode d'auth, reverse-proxy…).

**N'incluez pas** de données réelles d'exploitation : pas d'identifiants ou de secrets de
production, pas de données personnelles, pas de dumps. Limitez tout PoC au strict nécessaire
pour démontrer la faille — n'exploitez pas au-delà, et ne touchez pas à des systèmes qui ne
vous appartiennent pas.

## 2. Périmètre — quoi rapporter, quoi ne pas rapporter

### Dans le périmètre

Tout ce que le [modèle de menace](THREAT-MODEL.md) **§5 (« Ce qui est protégé »)** affirme
protéger et qui ne tiendrait pas. Notamment :

- **Contournement de la racine de confiance** (§5.1) : casser le seal/pinning à l'enrôlement,
  rejouer un enrôlement, contourner la vérification de signature par-message ou l'anti-downgrade
  du canal v2, contourner la vérification minisign de l'auto-upgrade, ou déchiffrer `agent.key`
  à partir d'une **copie isolée** du fichier de clé.
- **Évasion du confinement de l'agent** (§5.2) : obtenir une exécution root au-delà des actions
  définies — échappement du privhelper, injection via sudoers, `find -exec`, contournement des
  trois verrous de `script.execute` ou du gate ADMIN de `script.execute` / `process.kill`.
- **Contournement de la frontière web** (§5.3) : élévation de rôle RBAC (atteindre
  `dispatchAction` sans rôle, faire passer un READONLY/OPERATOR pour ADMIN), CSWSH sur le
  WebSocket dashboard, SSRF atteignant une cible interne malgré la garde, accès non authentifié
  à `/metrics` quand un token est configuré, mass-assignment, etc.
- Toute faille web classique non couverte ci-dessus (injection, désérialisation, fuite de
  secret, authentification cassée…).

### Hors périmètre

Plusieurs choses **ressemblent** à des vulnérabilités mais sont des **limites assumées et
documentées** — les signaler ajoute du bruit sans rien apprendre. Avant de rapporter,
vérifiez le [modèle de menace](THREAT-MODEL.md) **§6 (« Ce qui n'est PAS protégé »)** et
**§3 (« hors du modèle d'attaquant »)**.

Non-vulnérabilités connues (voir le threat model pour le détail, non recopié ici) :

- **Vol d'un snapshot/backup disque complet** d'un hôte d'agent → re-dérivation de `agent.key`
  (§6.1). Le chiffrement at-rest ne protège qu'une copie *isolée* du fichier.
- **Absence d'isolation entre locataires** : tout OPERATOR agit sur tout le parc, tout READONLY
  lit tout (§6.2). Une instance = un domaine de confiance unique, *par conception*.
- **La garde anti-SSRF bloque les réseaux privés par défaut** : ne pas pouvoir notifier un
  service interne (ntfy/Gotify/webhook LAN) n'est pas un bug (§6.3).
- **Un backend de confiance commande les agents en root** : c'est la fonction du produit, pas
  une faille (§4-A). De même, un attaquant **déjà root** sur l'hôte d'un agent est explicitement
  hors modèle (§3).
- Les sorties Keycloak (JWKS) / SMTP non couvertes par la garde SSRF, et autres points listés
  en §6.4–§6.6.

Si vous pensez qu'une « limite assumée » est en réalité exploitable **au-delà** de ce que le
threat model décrit (p. ex. un contournement SSRF atteignant le réseau privé *sans* allow-list,
ou une re-dérivation de clé *sans* accès disque complet), **c'est dans le périmètre** —
signalez-le.

## 3. Versions supportées

Nexus est en cours d'ouverture, **pré-1.0**. Le support est volontairement minimal et honnête :

| Version | Supportée |
|---|---|
| Dernière `master` / dernière release publiée | ✅ |
| Versions antérieures, pré-releases (`v0.0.1-staging`, etc.) | ❌ |

- Seul l'état le plus récent (`master` à jour, ou la dernière release) reçoit des correctifs de
  sécurité.
- **Pas de backport** de correctifs sur d'anciennes versions tant que le projet est pré-1.0.
- Mettez à jour vers la dernière version avant de signaler — la faille peut déjà être corrigée.

Cette politique sera revue à la première version stable (1.0).

## 4. Divulgation coordonnée

Nous suivons une divulgation **coordonnée**, en **meilleur effort** (le projet est porté par une
petite équipe — pas de SLA contractuel) :

1. **Accusé de réception** de votre rapport dans un délai raisonnable.
2. **Évaluation** : nous confirmons (ou non) la faille et son périmètre, et échangeons avec vous
   si besoin.
3. **Correctif** : nous travaillons à une correction et, le cas échéant, à une mesure
   d'atténuation provisoire.
4. **Divulgation** une fois le correctif disponible, de façon coordonnée avec vous — idéalement
   publication simultanée du correctif et d'un avis (advisory).
5. **Crédit** : nous créditons volontiers le rapporteur dans l'avis, si vous le souhaitez (sinon,
   signalement anonyme respecté).

Nous vous demandons, en retour, de **ne pas divulguer publiquement** la faille tant qu'un
correctif n'est pas disponible, et de nous laisser un délai raisonnable pour le produire.

Merci d'aider à garder Nexus sûr.
