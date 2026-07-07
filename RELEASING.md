# Releasing the Nexus agent

The agent binary is **not** shipped inside the backend image. The backend serves
it from a `release/` volume that you populate with a **signed** release. Until you
do, `/api/agents/download` returns `500` and you can neither install nor upgrade
an agent — this is fail-closed by design.

This guide is the **CI-agnostic** way to build, sign, and publish a release.
(`scripts/nexus-release.sh` automates the same thing but is tied to the
maintainer's GitLab CI — see the note at the end.)

The trust model: releases are signed with an **offline minisign key** you hold.
The backend only relays the signature; a compromised backend cannot push a
trojaned binary. See [OPERATOR-KEYS.md](OPERATOR-KEYS.md) and the "Supply chain &
agent integrity" section of the [README](README.md).

## Prerequisites

- [minisign](https://jedisct1.github.io/minisign/) installed (`apt install minisign` / `brew install minisign`).
- Either Go 1.23 **or** Docker (to build the binary).
- A running backend with a strong `ECDSA_MASTER_SECRET` set (it refuses to start otherwise).

## One-time setup — the release key

1. Generate an offline release keypair (once):

   ```sh
   minisign -G -p nexus-release.pub -s nexus-release.key
   # choose a strong password; it encrypts nexus-release.key
   ```

   - `nexus-release.key` (private) → your secrets vault. **Never** commit it, put
     it in an image, or copy it onto an agent.
   - `nexus-release.pub` (public) → safe to share.

2. Give the **public** key to the backend so it auto-deploys `release.pub` to
   agents at install/re-enroll. In the backend `.env`, set the single base64 line
   (`RW…`) of `nexus-release.pub`:

   ```sh
   NEXUS_RELEASE_PUBKEY=RW....
   ```

See [OPERATOR-KEYS.md](OPERATOR-KEYS.md) for key custody, rotation, and the
optional script-signing key.

## Per release — build → sign → publish

Pick a version (semver), e.g. `0.1.0`. The **same** string must be baked into the
binary and written to `VERSION` (the self-upgrade check requires
`nexus-agent --version` to equal the published version).

### 1. Build the agent (reproducible, static)

With Go:

```sh
cd agent
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -mod=readonly \
  -ldflags "-w -s -X main.Version=0.1.0" -o ../nexus-agent ./cmd/nexus-agent
cd ..
```

Or with Docker (no Go needed, pinned toolchain — same bytes as CI):

```sh
docker run --rm -v "$PWD/agent:/src:ro" -v "$PWD:/out" \
  golang:1.23-alpine@sha256:383395b794dffa5b53012a212365d40c8e37109a626ca30d6151c8348d380b5f \
  sh -c 'cd /src && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -mod=readonly \
    -ldflags "-w -s -X main.Version=0.1.0" -o /out/nexus-agent ./cmd/nexus-agent'
```

### 2. Sign it (offline)

```sh
minisign -S -s nexus-release.key -m nexus-agent
# produces nexus-agent.minisig
```

### 3. Write the VERSION file

```sh
printf '0.1.0\n' > VERSION
```

### 4. Publish into the release volume

The backend reads three files from its `release/` volume
(`./release` on the host by default, mounted read-only — see `docker-compose.yml`):
`nexus-agent`, `nexus-agent.minisig`, `VERSION`.

```sh
mkdir -p release
cp nexus-agent nexus-agent.minisig VERSION release/
```

No backend restart is needed — it reads these on demand. Do **not** commit the
`release/` contents; they are deployment artifacts.

## Verify

- `GET /api/agents/download` no longer returns `500`.
- In the UI, **Machines → Add a machine** now produces a full install command.
- Install the first agent on a target host (run the generated command as root).
  The agent verifies the minisign signature against the `release.pub` it received,
  fail-closed.

Anyone can independently rebuild the binary and confirm it matches the signed
`sha256` — see "Reproducible build verification" in [OPERATOR-KEYS.md](OPERATOR-KEYS.md).

## Rollout to existing agents (upgrades)

Once a newer signed release is in `release/`, the backend reports the new version
in each agent's status; trigger the self-upgrade from the UI (or
`POST /api/machines/:id/agent/upgrade`). The agent downloads only from its pinned
backend over https, re-checks the signature and an anti-rollback version floor,
and reverts via a dead-man's switch if the new binary fails to reconnect.

## Optional — distribute the binary via GitHub Releases

The `release/` volume above is what your **backend** serves to agents. If you also
want to distribute the signed binary **publicly** (manual installs, third-party
verification), attach it to a GitHub Release. Publish the **same** already-signed
bytes — never re-sign (a second signature diverges and re-prompts for the offline
key). A GitHub Release is a distinct object: if you mirror the repo to GitHub, the
mirror carries tags/commits but **not** Releases, so this is an explicit step.

1. Re-verify locally before publishing (never upload unverified bytes), and build
   the checksums:

   ```sh
   minisign -Vm nexus-agent -p nexus-release.pub
   sha256sum nexus-agent nexus-agent.minisig nexus-release.pub > SHA256SUMS
   ```

2. Ensure the tag already exists on GitHub. If you mirror the repo, wait for the
   tag to propagate first — the Release must attach to the existing (mirrored)
   tag, not create a competing one.

3. Create the Release and upload the assets with the
   [`gh`](https://cli.github.com/) CLI (authenticated, scope `contents:write`):

   ```sh
   gh release create v0.1.0 \
     nexus-agent nexus-agent.minisig nexus-release.pub SHA256SUMS \
     -R owner/repo --verify-tag --title v0.1.0 \
     --notes 'Verify: minisign -Vm nexus-agent -p nexus-release.pub && sha256sum -c SHA256SUMS'
   ```

Consumers verify with the published `nexus-release.pub` (pin it out-of-band) — the
same trust model as the in-product signed auto-upgrade.

## Maintainer automation (GitLab)

`scripts/nexus-release.sh` does all of the above **for a GitLab CI setup**: it
creates the tag, waits for the `release-build` job artifact, shows the `sha256`
for approval, signs offline, and rsyncs the trio to a prod host. It is specific to
the maintainer's GitLab + prod host; use this manual guide otherwise.
