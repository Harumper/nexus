# Operator Key Management

Nexus relies on a small set of **trust keys**. This guide explains how to generate
and deploy them, where each private key must live, and what to do if one is lost
or compromised. It is the operational companion to the
[threat model](THREAT-MODEL.md) §5.1 (the trust root) and §7.2 (operator
responsibilities).

**Read this before bootstrapping a deployment.** Two of these keys are generated
**offline by you** and cannot be recreated by Nexus — a lost private key means
re-deployment; a stolen one means the corresponding trust root is compromised.

## Overview — what you actually generate

There are three trust anchors, but **you only generate two of them offline**:

| # | Key | Who generates it | Algorithm | You run a command? |
|---|-----|------------------|-----------|--------------------|
| 1 | Server identity key (enrollment pinning) | **The backend, automatically, per machine** | ECDSA / ECDH P-256 | No — but you must protect it via `ECDSA_MASTER_SECRET` |
| 2 | Release signing key (signed auto-upgrade) | **You, offline** | minisign (Ed25519) | Yes |
| 3 | Script signing key (`script.execute`) | **You, offline** | minisign (Ed25519) | Yes — only if you enable `script.execute` |

> Keys 2 and 3 use [minisign](https://jedisct1.github.io/minisign/). Install it
> first (`apt install minisign`, `brew install minisign`, or from the project
> page). Nexus verifies signatures with the `aead.dev/minisign` library, which is
> compatible with the standard `minisign` CLI.

---

## 1. Server identity key — enrollment pinning

**What it does.** Anchors the agent↔backend trust at enrollment ([threat model](THREAT-MODEL.md)
§5.1, *Bootstrap* and *Canal runtime*). The agent seals its enrollment request to
this key and verifies every signed server message against it. Each machine gets
its **own** keypair.

**What an attacker gains by compromising it.** The per-machine **private** key lets
an attacker impersonate the backend to that agent — forge a valid enrollment
response and signed `action.request` messages, i.e. **run actions as root on that
host**.

**You do not generate this key.** The backend generates the keypair automatically
when you create the machine / its enrollment token
(`backend/src/services/crypto.ts` → `generateEcdsaKeypair`, P-256). The **public**
key is delivered to the agent inside the install command produced by the backend
(`--server-public-key-file`), and pinned on the agent at:

```
/etc/nexus/server-public-key.pem      # owner root:nexus-agent, mode 0640
                                       # PEM, PKIX/SPKI, curve P-256
```

The **private** key never leaves the backend: it is stored in the database
**encrypted at rest** with `ECDSA_MASTER_SECRET` (AES-256-GCM). Your responsibility
for this key is therefore **indirect but critical**:

- **Generate a strong `ECDSA_MASTER_SECRET`** (it encrypts every per-machine server
  private key in the database):
  ```sh
  openssl rand -hex 32
  ```
  Put it in the backend environment (`.env`). The backend refuses to start if it
  is missing, too short, or a known placeholder. Anyone who obtains both the
  database **and** `ECDSA_MASTER_SECRET` can decrypt all server private keys and
  impersonate the backend — treat `ECDSA_MASTER_SECRET` as a root secret (see
  *Private key storage* below).
- **Pin verification.** When you bootstrap an agent, the public key travels in the
  backend-generated install command. On a trustworthy network this is fine; if you
  want defense against a tampered command, compare the
  `--server-public-key-file` content against the machine's `backendPublicKey` as
  returned by the API (`backendPublicKey` is exposed by `routes/machines.ts`) before
  running the installer.

> Note: unlike keys 2 and 3, this key is **not** something you provision fully
> offline — the backend holds both halves (public in clear, private encrypted).
> Pinning protects against an on-path key swap during enrollment, not against a
> fully compromised backend (see [threat model](THREAT-MODEL.md) §4-A).

---

## 2. Release signing key — signed auto-upgrade

**What it does.** Authenticates agent binaries for the self-upgrade
([threat model](THREAT-MODEL.md) §5.1, *Sommet*). The agent installs an upgrade
only if the binary carries a valid **detached minisign signature** verified against
a **local** public key the operator deployed — the backend never holds the private
key, so a compromised backend cannot push a trojaned binary.

**What an attacker gains by compromising it.** The **private** key lets an attacker
sign a malicious agent binary that passes upgrade verification → **root code
execution on every agent** in the fleet. This is the highest-value key here.

**Generate it (offline, once):**

```sh
minisign -G -p nexus-release.pub -s nexus-release.key
# prompts for a password that encrypts nexus-release.key
```

- **Private key** `nexus-release.key` → your secrets vault (see below). It is used
  **only** to sign releases, on an offline/controlled machine:
  ```sh
  minisign -S -s nexus-release.key -m nexus-agent
  # produces nexus-agent.minisig, published next to the binary the backend serves
  ```
- **Public key** `nexus-release.pub` → deployed to **every agent** at:
  ```
  /etc/nexus/release.pub                # owner root:root, mode 0644
  ```
  **Recommended (automatic):** set `NEXUS_RELEASE_PUBKEY` on the **backend** (the
  contents of `nexus-release.pub`). The backend then embeds it in the install
  command it generates, so `/etc/nexus/release.pub` is written automatically at
  **install and at re-enroll** — no manual step, and it can't silently go missing
  after a re-enroll (which purges `/etc/nexus`). It's a public key, so nothing
  secret transits.
  In the backend `.env`, use the **single base64 line** of `nexus-release.pub`
  (the `RW…` line; the `untrusted comment:` header is optional — it's ignored):
  ```
  NEXUS_RELEASE_PUBKEY=RWRo+LdKCdUi1/4rXyYU206e9dw8+TOxBGI/YC0cIrK56hlAdjpJBIyY
  ```
  *(Multi-line is fine only via a shell export, e.g.
  `export NEXUS_RELEASE_PUBKEY="$(cat nexus-release.pub)"` before `docker compose up` —
  NOT as a literal line in a `.env` file. As a GitLab CI variable, paste either form.)*
  **Manual (override / high-assurance):** deploy it out of band instead, at install:
  ```sh
  sudo ./install-agent.sh ... --release-pubkey-file nexus-release.pub
  ```
  or place/replace `/etc/nexus/release.pub` directly (root:root 0644). The installer
  **does not overwrite an existing** `release.pub` — to change a pinned key, remove
  the file first or `--reenroll` (which purges `/etc/nexus`). If absent, the agent
  runs normally but **refuses every auto-upgrade** (fail-closed).

> You can paste the `.pub` file as-is: the `untrusted comment:` header line is
> ignored. The file is an **accept-list** — one key per line — which makes
> rollover possible (see *Rotation*).

---

## 3. Script signing key — `script.execute` (optional)

**What it does.** Independent lock on remote script execution
([threat model](THREAT-MODEL.md) §5.2). When `script.execute` is enabled, the agent
runs a script only if it carries a valid detached minisign signature
(`script_sig`) verified against a **local** public key — the backend relays the
signature but never holds the private key.

**Only needed if you enable `script.execute`** (off by default; requires
`--allow-remote-script` at install **and** `ALLOW_REMOTE_SCRIPT=true` on the
backend **and** this signature). If you do not use `script.execute`, skip this key.

**What an attacker gains by compromising it.** The **private** key lets an attacker
sign arbitrary scripts → if `script.execute` is enabled, **root code execution on
agents**.

**Generate it (offline, once):**

```sh
minisign -G -p nexus-script-signing.pub -s nexus-script-signing.key
```

- **Private key** `nexus-script-signing.key` → your secrets vault. Used to sign the
  **exact bytes** of each script you intend to run:
  ```sh
  minisign -S -s nexus-script-signing.key -m myscript.sh
  # produces myscript.sh.minisig; its content is the `script_sig` you submit
  ```
  > Sign the exact script payload you will send (the agent verifies the signature
  > against the raw script bytes, before any shebang is added).
- **Public key** `nexus-script-signing.pub` → deployed to agents that may run
  scripts, at:
  ```
  /etc/nexus/script-signing.pub         # owner root:root, mode 0644
  ```
  ```sh
  sudo ./install-agent.sh ... --script-signing-pubkey-file nexus-script-signing.pub
  ```

Use a **separate keypair** from the release key — distinct roles, independently
revocable.

---

## Reproducible build verification

The signed agent binary is built reproducibly, so you don't have to trust the
release key blindly — you can rebuild the binary from source and confirm it
matches the `sha256` that was signed.

The CI `release-build` job builds with a Go toolchain **pinned by digest**,
`CGO_ENABLED=0`, `-trimpath`, and `-mod=readonly` (dependencies pinned by
`go.sum`). These remove the usual sources of non-determinism, so the same source
plus the same version string produce the same bytes on any machine.

To verify a release:

```sh
# 1. Check out the exact commit/tag the release was built from.
git checkout <release-tag>

# 2. Rebuild with the pinned toolchain (any path — -trimpath makes it path-independent).
docker run --rm -v "$PWD/agent:/src:ro" \
  golang:1.23-alpine@sha256:383395b794dffa5b53012a212365d40c8e37109a626ca30d6151c8348d380b5f \
  sh -c 'cp -r /src /b && cd /b && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -mod=readonly \
    -ldflags "-w -s -X main.Version=<RELEASE_VERSION>" \
    -o /tmp/nexus-agent ./cmd/nexus-agent && sha256sum /tmp/nexus-agent'

# 3. Compare the sha256 with nexus-agent.sha256 published next to the signed
#    binary, and verify the signature: minisign -Vm nexus-agent -p release.pub
```

`RELEASE_VERSION` must be the exact version string of the release — it is embedded
in the binary via `-ldflags -X main.Version`, so a different string changes the
bytes. It is published in the release's `VERSION` file.

## Private key storage

The private halves of keys 2 and 3, and the `ECDSA_MASTER_SECRET` for key 1, are
the crown jewels. Protect them accordingly:

- **Use a secrets manager / vault** (e.g. Vault, Passbolt, 1Password, a hardware
  token). Do not leave private keys on disk on a shared or internet-facing host.
- **Never** put a private key (or `ECDSA_MASTER_SECRET`) in the repository, in
  container images, in CI logs, or in the Nexus UI. Trust keys are provisioned
  **out of band**, never through the application.
- **Never** copy a release or script-signing **private** key onto an agent. Agents
  only ever receive **public** keys.
- Encrypt the minisign private keys with a strong password at generation time
  (minisign prompts for one) and store that password separately from the key.
- Keep an **offline backup** of each private key. The trade-off is stark:
  - **Lost private key** → you must re-deploy: re-issue the public key and
    re-enroll / re-sign (recoverable, but disruptive).
  - **Stolen private key** → the corresponding trust root is compromised (silent
    backend impersonation, or signed malicious binaries/scripts). Rotate
    immediately (next section).

---

## Rotation & compromise response

Key rotation is **manual today**; automatic key rotation is on the roadmap
([threat model](THREAT-MODEL.md) Annexe A, finding CRYPTO-002). The manual paths:

### Server identity key (key 1)
- **Rotate one machine:** re-enroll it. `POST /api/machines/:id/re-enroll`
  regenerates the keypair + enrollment token, disconnects the agent, and produces a
  fresh bootstrap command (with the new pinned public key). Re-run the installer
  with `--reenroll`.
- **`ECDSA_MASTER_SECRET` compromise:** this exposes every server private key in the
  database. Rotating it requires re-encrypting the stored private keys; the safest
  operational path is to **rotate the secret and re-enroll the affected agents** so
  fresh keypairs are issued. Treat a leaked `ECDSA_MASTER_SECRET` as a full
  control-plane compromise.

### Release signing key (key 2) and script signing key (key 3)
Both use the same minisign accept-list mechanism, which supports **rollover without
downtime** (the agent accepts a signature from *any* key in the list):

1. Generate a new keypair (`minisign -G ...`).
2. Deploy a `.pub` file containing **both** the old and the new public keys (one per
   line) to `/etc/nexus/release.pub` (or `script-signing.pub`) on all agents.
3. Start signing new releases/scripts with the **new** private key.
4. Once every agent has the updated accept-list and is on a new-key-signed
   artifact, deploy a `.pub` containing **only the new key**, retiring the old one.

If a private key is **stolen**, skip the grace period: deploy the `.pub` with only
the new key immediately, and (for the release key) re-sign and roll out a known-good
binary so no agent is left trusting a key the attacker holds.

---

## Final checklist

Before going to production:

- [ ] `ECDSA_MASTER_SECRET` generated (`openssl rand -hex 32`), strong, set in the
      backend environment, and stored in your vault.
- [ ] Release keypair generated offline (`minisign -G`); **private** key in the
      vault, **never** on an agent.
- [ ] `nexus-release.pub` deployed to every agent at `/etc/nexus/release.pub`
      (`root:root 0644`) via `--release-pubkey-file`.
- [ ] (If using `script.execute`) Script-signing keypair generated offline;
      **private** key in the vault.
- [ ] (If using `script.execute`) `nexus-script-signing.pub` deployed at
      `/etc/nexus/script-signing.pub` (`root:root 0644`) via
      `--script-signing-pubkey-file`.
- [ ] Each agent's pinned `/etc/nexus/server-public-key.pem` matches the machine's
      backend public key.
- [ ] No private key (or `ECDSA_MASTER_SECRET`) is in the repo, an image, CI logs,
      or the UI.
- [ ] Offline backups of all private keys exist, stored separately from their
      passwords.
