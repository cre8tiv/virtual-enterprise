---
name: setup-authentik
description: Run SETUP.md Phase 6b for the virtual enterprise. Deploys authentik (primary workforce IdP) on the cloud site, publishes it at https://sso.<domain> through the Cloudflare Tunnel, and provisions the org model's groups and 25 personas with vaulted passwords and their shared TOTP seeds, then verifies an MFA sign-in. Use when starting 6b, resuming it, or re-syncing after canonical/org changes.
disable-model-invocation: true
---

# Setup: Phase 6b authentik

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 6b. Run from the repo root. `vm` below means `ssh -i ~/.config/virtual-enterprise/cloud_ssh <Cloud VM address>`, with commands run in `/opt/ve/cloud`.

**Idempotent by design:** secrets sync through `secret-env.mjs`, `docker compose up -d` converges, tunnel ingress and DNS are read before change, and `scripts/authentik/provision.mjs` plans from live state.

**Secret hygiene:** authentik's secrets live in `infra/compose/cloud/.env` (gitignored, copied to the VM with mode 600) and the vault. The TOTP seeds go to the VM over SSH stdin, never as command arguments.

## Steps

### 1. Preconditions

1. Phase 5a is done: the registry has **Cloud VM address** and the `cloud` tunnel is healthy.
2. Phase 6a is done: persona TOTP seeds exist (`node scripts/lib/totp.mjs code <any persona UPN>` prints a code).

### 2. Configuration and secrets

1. `node scripts/env/set-env.mjs infra/compose/cloud/.env AUTHENTIK_BOOTSTRAP_EMAIL=sso-admin@svc.<domain>`. If **Email Routing mode** is `per-address rules`, add a forwarding rule for that address.
2. Sync each secret (generated once, vault first):
   - `node scripts/env/secret-env.mjs infra/compose/cloud/.env AUTHENTIK_SECRET_KEY "Service & API" "authentik: secret key"`
   - `node scripts/env/secret-env.mjs infra/compose/cloud/.env AUTHENTIK_PG_PASS "Service & API" "authentik: PostgreSQL" --username authentik`
   - `node scripts/env/secret-env.mjs infra/compose/cloud/.env AUTHENTIK_BOOTSTRAP_PASSWORD "Service & API" "authentik: akadmin" --username akadmin --uri https://sso.<domain>/if/admin/`
   - `node scripts/env/secret-env.mjs infra/compose/cloud/.env AUTHENTIK_BOOTSTRAP_TOKEN "Service & API" "authentik: API token"`

   The bootstrap values apply only on authentik's first start. After that, changing them in `.env` does nothing, so a "differ" error means asking which value is live.

### 3. Deploy

1. `scp -i ~/.config/virtual-enterprise/cloud_ssh infra/compose/cloud/docker-compose.yml infra/compose/cloud/.env <Cloud VM address>:/opt/ve/cloud/`
2. `vm "chmod 600 /opt/ve/cloud/.env && cd /opt/ve/cloud && docker compose up -d"` (cloudflared keeps running; the authentik services are added).
3. Wait until `vm "cd /opt/ve/cloud && docker compose ps"` shows `authentik-postgresql` healthy and both authentik containers running. The first start runs migrations for a few minutes; `docker compose logs --tail 30 authentik-server` shows progress.

### 4. Publish `sso.<domain>`

Through the `cloudflare` MCP, add the ingress rule `sso.<domain>` → `http://authentik-server:9000` to tunnel `cloud` (keep existing rules; the catch-all `http_status:404` stays last) and a proxied CNAME `sso` → `<tunnel ID>.cfargotunnel.com`. Leave Cloudflare Access off this hostname: it's the IdP that SSO clients and the SUT reach.

Done when `curl -s -o /dev/null -w "%{http_code}" https://sso.<domain>/-/health/ready/` prints `200`.

### 5. Admin account (operator)

The operator signs in at https://sso.<domain>/if/admin/ as `akadmin` (password from Passbolt `Service & API` / `authentik: akadmin`), enrolls a TOTP authenticator for akadmin (user settings → MFA devices), and copies the akadmin credentials into `Break-glass`.

### 6. Provision

1. `node scripts/authentik/provision.mjs` (plan). Summarize the groups, users, passwords, and TOTP devices to create.
2. On an explicit yes, `--apply`. Persona passwords are stored in the vault's `Personas` folder as `authentik: <upn>` before they're set; TOTP devices are created with `ak shell` over SSH from the persona seeds.
3. Re-run the plan until it prints `No changes`. A warning about the MFA validation stage means the default authentication flow was changed; restore a validation stage that accepts TOTP.

MFA note: the default flow's validation stage prompts for any configured device and skips users without one. Every persona has a device, so their sign-ins require TOTP; akadmin is prompted too once enrolled in step 5.

### 7. Verify an MFA sign-in (operator)

In a private window, sign in at https://sso.<domain>/ as a persona (username = UPN, password from Passbolt `Personas` / `authentik: <upn>`), then enter the code from `node scripts/lib/totp.mjs code <upn>`.

Done when the persona lands on the authentik user dashboard.

### 8. Record and report

Record **authentik URL** `https://sso.<domain>` and the version (`curl -s -H "Authorization: Bearer <token>" https://sso.<domain>/api/v3/admin/version/` read through the vault token). Note what's deferred: outbound email (recovery, notifications) waits on the SMTP relay decision (DESIGN.md §10); SSO/SCIM apps for the SUT come in Phase 12.

Next step: **Phase 6c: Okta** (`/setup-okta`) if not done, else **Phase 7: HR**.
