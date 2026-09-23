---
name: setup-vault
description: Run SETUP.md Phase 2 for the virtual enterprise. Starts the Passbolt CE operator vault in Docker at https://vault.<domain>, registers the admin and automation users, configures go-passbolt-cli and the vault adapter, creates the folder structure, moves bootstrap secrets in, and takes the first backup. Use when starting Phase 2 or resuming an interrupted one.
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
2. `infra/compose/vault/.env` has `APP_FULL_BASE_URL=https://vault.<domain>` (written in Phase 1). If missing, set it with `set-env.mjs`.
3. `docker info` succeeds (daemon running).

Done when all three hold.

### 2. Bind address and hostname

The hosts file maps a name to an IP, never to a port, so a conflict on 443 is solved with a different **loopback address** and the URL stays `https://vault.<domain>`.

1. If `compose ps` shows the vault running, keep `BIND_ADDR` from `infra/compose/vault/.env` and go to 4.
2. Probe 443 on the current `BIND_ADDR` (default `127.0.0.1`):
   `node -e "const s=require('net').createServer();s.once('error',e=>{console.log(e.code);process.exit(1)});s.listen(443,process.argv[1],()=>{console.log('free');s.close()})" <addr>`
   - `free` → keep it.
   - `EACCES` (Linux without root) → the probe can't tell; keep it and let `compose up` report a conflict in step 4.
   - `EADDRINUSE` → probe `127.0.0.2`. On macOS the operator first runs `sudo ifconfig lo0 alias 127.0.0.2` (lost on reboot unless persisted with a launchd job). If free, set it: `node scripts/env/set-env.mjs infra/compose/vault/.env BIND_ADDR=127.0.0.2`.
   - Both taken (something listens on all addresses) → stop and present the options: stop the conflicting service, route `vault.<domain>` through the operator's existing reverse proxy, host the vault on another machine now, or, last resort, a non-443 `HTTPS_PORT`. That port becomes part of the permanent `APP_FULL_BASE_URL`, so the operator must accept that explicitly.
3. Record the address as **Vault bind address** in `local/registry.md`.
4. Check resolution: `node -e "require('dns').lookup('vault.<domain>',(e,a)=>console.log(e?e.code:a))"`. If it doesn't print `BIND_ADDR`, give the operator the exact line `<BIND_ADDR>  vault.<domain>` and the hosts file path (Windows `C:\Windows\System32\drivers\etc\hosts`, macOS/Linux `/etc/hosts`; admin rights needed). Wait, then re-check.

Done when the lookup prints `BIND_ADDR` and that address has 443 free (or the vault already holds it).

### 3. Database password

`node scripts/env/set-env.mjs infra/compose/vault/.env PASSBOLT_DB_PASSWORD=$(node scripts/vault/vault.mjs generate) --if-empty`

`--if-empty` matters: once the database is initialized, changing this value breaks the stack. If it printed `set`, tell the operator the password now lives in `infra/compose/vault/.env` and moves into the vault in step 8.

### 4. Start and health

1. `compose up -d` (a no-op when already running), then wait until `compose ps` shows both services running and `db` healthy. A "port is already allocated" / "address already in use" error means step 2's probe missed a conflict: return to step 2 with the next loopback address.
2. Healthcheck: `compose exec passbolt su -s /bin/bash -c '/usr/share/php/passbolt/bin/cake passbolt healthcheck' www-data`

Done when the healthcheck shows no errors other than the expected ones: self-signed certificate, and email/SMTP not configured.

### 5. Admin user

Run the users query and branch:

- **No admin:** ask for the operator's first and last name, then:
  `compose exec passbolt su -s /bin/bash -c '/usr/share/php/passbolt/bin/cake passbolt register_user -u <operator mailbox> -f <first> -l <last> -r admin' www-data`
  and give the operator the printed registration URL.
- **Admin exists, `active = 0`:** setup was started but not finished. Ask whether the operator still has the registration link; if not, find the command that reissues it (`cake passbolt --help`, e.g. `recover_user`) and run it.
- **Admin exists, `active = 1`:** skip to step 6.

The operator, in their main browser profile, confirming each item:

1. Opens the URL, accepts the self-signed certificate, installs the extension, sets a strong passphrase.
2. Downloads the **recovery kit** and stores it, with the passphrase, **outside Passbolt** (offline and/or personal password manager).
3. Enables TOTP (Administration → Multi Factor Authentication) and enrolls their account.

Done when the users query shows the admin with `active = 1` and the operator confirms the recovery kit and MFA.

### 6. Automation user

Same branching with `automation@svc.<domain>`, role `user` (`-f Automation -l Service -r user`).

The operator, in a **separate browser profile** so the admin session stays untouched:

1. Opens the registration URL, installs the extension, and sets a passphrase generated in their password manager.
2. Exports the private key (extension → Manage account → Keys inspector → download private key) to `~/.config/virtual-enterprise/automation.asc`.
3. Writes the passphrase to `~/.config/virtual-enterprise/automation.passphrase` (restrict permissions to their user) and keeps a copy in their password manager.

These two files together are the automation identity. It never gets access to `Break-glass`, which limits the impact of files on disk.

Done when the users query shows `active = 1` and `test -f` succeeds for both files.

### 7. CLI and adapter

1. `passbolt configure --config ~/.config/virtual-enterprise/passbolt.toml --serverAddress https://vault.<domain> --userPrivateKeyFile ~/.config/virtual-enterprise/automation.asc --tlsSkipVerify` (safe to re-run; the passphrase is not stored in the config).
2. `node scripts/vault/vault.mjs whoami`

Done when `whoami` prints `ok`.

### 8. Folders and bootstrap secrets

1. For each of `Vendor admins`, `Personas`, `Customers`, `Service & API`:
   `node scripts/vault/vault.mjs ensure-folder "<name>" --share-owner <operator mailbox>`
   The automation user creates them and makes the admin an Owner.
2. **`Break-glass`** is created by the operator in the Passbolt UI and shared with no one, so the automation user never sees it. Confirm with the operator.
3. Store the DB password (the adapter skips it if already present):
   `node scripts/vault/vault.mjs upsert "Service & API" "Passbolt database" --username passbolt --uri "infra/compose/vault" --password "$(grep '^PASSBOLT_DB_PASSWORD=' infra/compose/vault/.env | cut -d= -f2-)"`
4. The operator adds to `Break-glass` in the UI: Cloudflare login + 2FA recovery codes, and the automation passphrase.

Done when all five folders exist, the DB password resource exists, and the operator confirms the `Break-glass` entries.

### 9. Backup

1. Ask for a backup directory **outside the repo** (default `~/virtual-enterprise-backups`).
2. `bash infra/compose/vault/backup.sh <dir>`
3. Verify the new backup folder contains a non-empty `passbolt.sql` and `gpg/serverkey_private.asc`. Remind the operator to keep backups encrypted/offline together with the recovery kit.

Done when the backup is verified.

### 10. Record and report

Update `local/registry.md`: **Vault host** (`node -e "console.log(require('os').hostname())"`), **Vault backup location**, and confirm **Vault URL** and **Vault automation user** show the real domain.

Summarize what was set up and what remains manual, noting that SMTP is configured in Phase 4. Next step: **Phase 3: Email Catch-All**.
