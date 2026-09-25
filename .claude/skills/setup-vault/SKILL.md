---
name: setup-vault
description: Run SETUP.md Phase 2 for the virtual enterprise. Starts the Passbolt CE operator vault in Docker at https://vault.<domain> with a trusted Let's Encrypt certificate, registers the admin and automation users, configures go-passbolt-cli and the vault adapter, creates the folder structure, moves bootstrap secrets in, and takes the first backup. Use when starting Phase 2 or resuming an interrupted one.
disable-model-invocation: true
---

# Setup: Phase 2 Operator Vault

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 2. Run commands from the repo root; `compose` below means `docker compose` run in `infra/compose/vault/`.

**Idempotent by design:** every step checks live state first (DNS resolution, containers, the users table, folders, resources) and skips what's done. The operator does the browser-only work (registration, recovery kit, MFA) and the hosts-file edit. You handle the rest and verify each manual step before moving on.

**Secret hygiene:** read secrets only into commands, never into your replies. Check that secret files exist with `test -f`; never print them. The admin's passphrase and recovery kit never pass through you.

Helpers:

- `node scripts/env/set-env.mjs <file> KEY=VALUE [--if-empty]`: idempotent `.env` writes
- `node scripts/vault/vault.mjs <generate|whoami|ensure-folder|upsert|get>`: the vault adapter (see its header)
- Users query (shows who exists and who finished setup):
  `compose exec -T db sh -c 'mariadb -N -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "SELECT u.username, u.active, r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.deleted = 0"'`
- Automation identity files, outside the repo in `~/.config/virtual-enterprise/`: `automation.asc` (private key), `automation.passphrase`, `passbolt.toml` (CLI config)

## Steps

### 1. Preconditions and state

1. `local/registry.md` has **Domain** and **Operator mailbox** (Phases 0–1). If not, stop and point to the earlier skill.
2. `infra/compose/vault/.env` has `APP_FULL_BASE_URL=https://vault.<domain>`, `VAULT_HOST=vault.<domain>`, and `ACME_EMAIL` (written in Phase 1). Set any that are missing with `set-env.mjs`.
3. `docker info` succeeds (daemon running).

Done when all three hold.

### 2. Bind address and hostname

The hosts file maps a name to an IP, never to a port, so a conflict on 443 is solved with a different **loopback address** and the URL stays `https://vault.<domain>`.

1. If `compose ps` shows the vault running, keep `BIND_ADDR` from `infra/compose/vault/.env` and go to 4.
2. Probe 443 on the current `BIND_ADDR` (default `127.0.0.1`):
   `node -e "const s=require('net').createServer();s.once('error',e=>{console.log(e.code);process.exit(1)});s.listen(443,process.argv[1],()=>{console.log('free');s.close()})" <addr>`
   - `free` → keep it.
   - `EACCES` (Linux without root) → the probe can't tell; keep it and let `compose up` report a conflict in step 5.
   - `EADDRINUSE` → probe `127.0.0.2`. On macOS the operator first runs `sudo ifconfig lo0 alias 127.0.0.2` (lost on reboot unless persisted with a launchd job). If free, set it: `node scripts/env/set-env.mjs infra/compose/vault/.env BIND_ADDR=127.0.0.2`.
   - Both taken (something listens on all addresses) → stop and present the options: stop the conflicting service, route `vault.<domain>` through the operator's existing reverse proxy, host the vault on another machine now, or, last resort, a non-443 `HTTPS_PORT`. That port becomes part of the permanent `APP_FULL_BASE_URL`, so the operator must accept that explicitly.
3. Record the address as **Vault bind address** in `local/registry.md`.
4. Check resolution: `node -e "require('dns').lookup('vault.<domain>',(e,a)=>console.log(e?e.code:a))"`. If it doesn't print `BIND_ADDR`, give the operator the exact line `<BIND_ADDR>  vault.<domain>` and the hosts file path (Windows `C:\Windows\System32\drivers\etc\hosts`, macOS/Linux `/etc/hosts`; admin rights needed). Wait, then re-check.

Done when the lookup prints `BIND_ADDR` and that address has 443 free (or the vault already holds it).

### 3. Database password

`node scripts/env/set-env.mjs infra/compose/vault/.env PASSBOLT_DB_PASSWORD=$(node scripts/vault/vault.mjs generate) --if-empty`

`--if-empty` matters: once the database is initialized, changing this value breaks the stack. If it printed `set`, tell the operator the password now lives in `infra/compose/vault/.env` and moves into the vault in step 9.

### 4. TLS certificate token

Traefik gets a Let's Encrypt certificate for `vault.<domain>` through the Cloudflare DNS-01 challenge (a temporary TXT record), so it works with a hosts-file-only name and changes no local trust store. A trusted certificate is required: browsers and the extension treat a self-signed vault as insecure, and TOTP enrollment fails.

1. If `CLOUDFLARE_DNS_API_TOKEN` in `infra/compose/vault/.env` is non-empty (`grep -q '^CLOUDFLARE_DNS_API_TOKEN=.' infra/compose/vault/.env`), go to step 5.
2. The operator creates the token in the Cloudflare dashboard (My Profile → API Tokens → Create Token → "Edit zone DNS" template): permissions **Zone → Zone → Read** and **Zone → DNS → Edit**, zone resources limited to `<domain>`. Name it `vault-acme`.
3. The operator pastes it into `infra/compose/vault/.env` as `CLOUDFLARE_DNS_API_TOKEN=...` themselves, so the token never passes through the conversation, and keeps a copy in their personal password manager until step 9.

Done when the grep check succeeds.

### 5. Start, certificate, and health

1. `compose up -d` (a no-op when already running; on an older stack it adds Traefik and stops publishing Passbolt directly), then wait until `compose ps` shows all services running and `db` healthy. A "port is already allocated" / "address already in use" error means step 2's probe missed a conflict: return to step 2 with the next loopback address.
2. Certificate: `node -e "require('https').get('https://vault.<domain>/healthcheck/status.json',r=>console.log(r.statusCode,r.socket.getPeerCertificate().issuer.O)).on('error',e=>console.log(e.code))"`. Node validates against public CAs, so a `200` with issuer `Let's Encrypt` means the certificate is trusted. Issuance can take a minute or two; on errors, read `compose logs traefik` (usual causes: token permissions, wrong zone, rate limits; while testing, set `ACME_CA_SERVER` to the staging URL in `.env.example`).
3. Healthcheck: wait until the first-start migrations finish (the `metadata_keys` table exists; a "Table ... doesn't exist" error in the first minute is that), then run it with the server key fingerprint in the environment, because `compose exec` doesn't inherit it and the GPG and metadata checks fail without it:
   `fp=$(curl -s https://vault.<domain>/auth/verify.json | grep -o '"fingerprint":"[0-9A-F]*"' | cut -d'"' -f4)`
   `compose exec -T -e PASSBOLT_GPG_SERVER_KEY_FINGERPRINT=$fp passbolt su -w PASSBOLT_GPG_SERVER_KEY_FINGERPRINT -s /bin/bash -c '/usr/share/php/passbolt/bin/cake passbolt healthcheck' www-data`
   In Git Bash on Windows prefix the command with `MSYS_NO_PATHCONV=1`, or `/bin/bash` gets rewritten into a Git path.

Done when the certificate check prints `200 Let's Encrypt` and the healthcheck shows no errors other than email/SMTP not configured and "not configured to force SSL" (Traefik terminates TLS).

### 6. Admin user

Run the users query and branch:

- **No admin:** ask for the operator's first and last name, then:
  `compose exec passbolt su -s /bin/bash -c '/usr/share/php/passbolt/bin/cake passbolt register_user -u <operator mailbox> -f <first> -l <last> -r admin' www-data`
  and give the operator the printed registration URL.
- **Admin exists, `active = 0`:** setup was started but not finished. Ask whether the operator still has the registration link; if not, find the command that reissues it (`cake passbolt --help`, e.g. `recover_user`) and run it.
- **Admin exists, `active = 1`:** confirm the recovery kit and MFA items below are done (MFA may have failed earlier on a self-signed certificate), then go to step 7.

The operator, in their main browser profile, confirming each item:

1. Opens the URL (no certificate warning should appear), installs the extension, sets a strong passphrase.
2. Downloads the **recovery kit** and stores it, with the passphrase, **outside Passbolt** (offline and/or personal password manager).
3. Enables TOTP (Administration → Multi Factor Authentication) and enrolls their account.

Done when the users query shows the admin with `active = 1` and the operator confirms the recovery kit and MFA.

### 7. Automation user

Same branching with `automation@svc.<domain>`, role `user` (`-f Automation -l Service -r user`).

The operator, in a **separate browser profile** so the admin session stays untouched:

1. Opens the registration URL, installs the extension, and sets a passphrase generated in their password manager.
2. Exports the private key to `~/.config/virtual-enterprise/automation.asc`: in the Passbolt web app, avatar → Profile → Keys → **Download private key**. The recovery kit downloaded during setup is the same private key and can be renamed instead. Check that the file is the automation user's, not the admin's, before it goes into the identity (the two look the same).
3. Writes the passphrase to `~/.config/virtual-enterprise/automation.passphrase` (restrict permissions to their user) and keeps a copy in their password manager.

These two files together are the automation identity. It never gets access to `Break-glass`, which limits the impact of files on disk.

Signing in from a browser or profile that didn't do the registration shows "Check your mailbox" and waits for an emailed link, but SMTP doesn't exist until Phase 4. Issue a recovery link instead (for the admin or the automation user): `compose exec passbolt su -s /bin/bash -c '/usr/share/php/passbolt/bin/cake passbolt recover_user -u <email>' www-data`. The operator opens it, imports the private key (`automation.asc` for the automation user), and enters the passphrase.

Done when the users query shows `active = 1` and `test -f` succeeds for both files.

### 8. Metadata type, CLI and adapter

0. **Metadata type (operator, admin UI):** Administration → Organisation Settings → Encrypted Metadata: turn on **Enable legacy cleartext metadata** and select **Legacy cleartext metadata** as the default type; leave encrypted metadata enabled; save. `go-passbolt-cli` can't trust the server-issued metadata key (go-passbolt-cli #79), so v5 items created by the automation user can't be shared with the admin and never appear in the admin's vault. Do this before any item is created. To check: `passbolt create resource ... --debug` logs `DefaultResourceType:v4`. If v5 items already exist, delete and recreate them (persona passwords through `provision.mjs --rotate all`), and confirm with the operator first.

1. `passbolt configure --config ~/.config/virtual-enterprise/passbolt.toml --serverAddress https://vault.<domain> --userPrivateKeyFile ~/.config/virtual-enterprise/automation.asc` (safe to re-run; the passphrase is not stored in the config). The certificate is trusted, so TLS verification stays on; if an earlier config contains `tlsSkipVerify = true`, re-running configure without the flag should reset it. Confirm the file no longer has it.
2. `node scripts/vault/vault.mjs whoami`

Done when `whoami` prints `ok` with TLS verification on.

### 9. Folders and bootstrap secrets

1. For each of `Vendor admins`, `Personas`, `Customers`, `Service & API`:
   `node scripts/vault/vault.mjs ensure-folder "<name>" --share-owner <operator mailbox>`
   The automation user creates them and makes the admin an Owner.
2. **`Break-glass`** is created by the operator in the Passbolt UI and shared with no one, so the automation user never sees it. Confirm with the operator.
3. Store the DB password (the adapter skips it if already present):
   `node scripts/vault/vault.mjs upsert "Service & API" "Passbolt database" --username passbolt --uri "infra/compose/vault" --password "$(grep '^PASSBOLT_DB_PASSWORD=' infra/compose/vault/.env | cut -d= -f2-)"`
4. Store the ACME DNS token the same way:
   `node scripts/vault/vault.mjs upsert "Service & API" "Cloudflare API token: vault-acme" --uri "https://dash.cloudflare.com/profile/api-tokens" --password "$(grep '^CLOUDFLARE_DNS_API_TOKEN=' infra/compose/vault/.env | cut -d= -f2-)"`
5. The operator adds to `Break-glass` in the UI: Cloudflare login + 2FA recovery codes, and the automation passphrase.

Done when all five folders exist, both `Service & API` resources exist, and the operator confirms the `Break-glass` entries.

### 10. Backup

1. Ask for a backup directory **outside the repo** (default `~/virtual-enterprise-backups`).
2. `bash infra/compose/vault/backup.sh <dir>`
3. Verify the new backup folder contains a non-empty `passbolt.sql` and `gpg/serverkey_private.asc`. Remind the operator to keep backups encrypted/offline together with the recovery kit.

Done when the backup is verified.

### 11. Record and report

Update `local/registry.md`: **Vault host** (`node -e "console.log(require('os').hostname())"`), **Vault backup location**, and confirm **Vault URL** and **Vault automation user** show the real domain.

Summarize what was set up and what remains manual, noting that SMTP is configured in Phase 4. Next step: **Phase 3: Email Catch-All**.
