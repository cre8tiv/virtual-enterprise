---
name: setup-odoo
description: Run SETUP.md Phase 7a for the virtual enterprise. Deploys Odoo Community 19 (the HR system of record) on the cloud site, initializes the "hr" database, secures the admin account before publishing https://hr.<domain> through the Cloudflare Tunnel, and provisions the company, sites, departments, jobs, the 25 persona employees, the HR manager's user (with the persona's TOTP seed), and the SUT's API user. Use when starting 7a, resuming it, or re-syncing after canonical/org changes.
disable-model-invocation: true
---

# Setup: Phase 7a Odoo

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 7a. Run from the repo root. `vm` below means `ssh -i ~/.config/virtual-enterprise/cloud_ssh <Cloud VM address>`, with commands run in `/opt/ve/cloud`.

**Idempotent by design:** secrets sync through `secret-env.mjs`, the database is created only if missing, and `scripts/odoo/provision.mjs` plans from live state (employees are matched by Badge ID = canonical employee ID).

**Order matters for security:** a fresh Odoo database has the login `admin` / `admin`. Replace that password over SSH (step 4) **before** publishing `hr.<domain>` (step 5).

## Steps

### 1. Preconditions

1. Phase 5a is done (registry **Cloud VM address**; tunnel `cloud` healthy) and the registry has **Company name**.
2. Phase 6a is done (persona TOTP seeds exist), so the HR manager's Odoo user gets MFA.

### 2. Secrets and deploy

1. Sync the secrets:
   - `node scripts/env/secret-env.mjs infra/compose/cloud/.env ODOO_DB_PASSWORD "Service & API" "Odoo: PostgreSQL" --username odoo`
   - `node scripts/env/secret-env.mjs infra/compose/cloud/.env ODOO_MASTER_PASSWORD "Service & API" "Odoo: master password"`
2. Copy and start: `scp -i ~/.config/virtual-enterprise/cloud_ssh infra/compose/cloud/docker-compose.yml infra/compose/cloud/.env <Cloud VM address>:/opt/ve/cloud/`, then `vm "chmod 600 /opt/ve/cloud/.env && cd /opt/ve/cloud && docker compose up -d"`.
3. Wait until `vm "cd /opt/ve/cloud && docker compose ps"` shows `odoo-db` healthy and `odoo` running.

### 3. Database `hr`

1. Check: `vm "cd /opt/ve/cloud && docker compose exec -T odoo-db psql -U odoo -d postgres -tAc \"SELECT 1 FROM pg_database WHERE datname='hr'\""`. A `1` → go to step 4.
2. Demo data must stay out. Check the flag this Odoo version uses: `vm "cd /opt/ve/cloud && docker compose exec -T odoo odoo --help" | grep -E -- '--with-demo|--without-demo'`. If `--with-demo` is listed, demo data is off by default (no flag); otherwise add `--without-demo=all`.
3. Initialize: `vm "cd /opt/ve/cloud && docker compose exec -T odoo sh -c 'exec odoo -d hr -i base --stop-after-init --no-http --db_host \"\$HOST\" --db_user \"\$USER\" --db_password \"\$PASSWORD\" [demo flag]'"` (a few minutes), then `vm "cd /opt/ve/cloud && docker compose restart odoo"`.

Done when the check in 3.1 prints `1`.

### 4. Secure the admin account (before publishing)

`node scripts/odoo/provision.mjs --bootstrap-admin` creates the `Odoo: admin` password in the vault (if missing) and sets it with `odoo shell` over SSH. It prints `admin password set from the vault`. Safe to re-run.

### 5. Publish `hr.<domain>`

Through the `cloudflare` MCP, add the ingress rule `hr.<domain>` → `http://odoo:8069` to tunnel `cloud` (keep existing rules; `http_status:404` stays last) and a proxied CNAME `hr` → `<tunnel ID>.cfargotunnel.com`. Leave Cloudflare Access off this hostname: the SUT reaches Odoo's API here, and Odoo's own login protects it.

Done when `curl -s https://hr.<domain>/web/health` returns `{"status": "pass"}`.

### 6. Provision

1. `node scripts/odoo/provision.mjs` (plan). Summarize: HR apps to install (Employees, Time Off, Recruitment, Attendance, Expenses, two-factor authentication), company rename, site addresses and work locations, departments and heads, job positions, the 25 employees with managers, the two Odoo users (HR manager persona; `sut-odoo@svc.<domain>` for the SUT), and TOTP for the HR manager.
2. On an explicit yes, `--apply`. Installing the apps can take a few minutes. Passwords go into the vault first: `Personas` / `odoo: <hr-manager UPN>` and `Service & API` / `Odoo: SUT API user`.
3. Re-run until `No changes`.

Note: Odoo Community has no read-only HR group, so the SUT's API user is an Employees **Officer** (can edit employees). Record that in the report.

### 7. Verify (operator)

In a private window, sign in at https://hr.<domain>/odoo as the HR manager persona (password from Passbolt `Personas` / `odoo: <upn>`, then the code from `node scripts/lib/totp.mjs code <upn>`), and open Employees: 25 employees in 9 departments with the org chart filled in.

### 8. Record and report

Record **Odoo URL** `https://hr.<domain>` and **Odoo version** (from the provisioner's first line). Note: generated employees (the other ~375) load in Phase 10; joiner/mover/leaver changes made in Odoo drive IdP provisioning in Phase 13; SSO from authentik into Odoo (Odoo's OAuth module) is optional and not set up here.

Next step: **Phase 7b: Payroll database** (`/setup-payroll-db`).
