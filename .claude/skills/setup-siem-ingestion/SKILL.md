---
name: setup-siem-ingestion
description: Run SETUP.md Phase 8 for the virtual enterprise. Publishes Splunk's event collector at https://hec.<domain>, ships container logs from both sites to Splunk (Docker's splunk logging driver via a compose override), and pulls Entra, authentik, Okta, and Cloudflare audit and sign-in logs into Splunk with a checkpointed collector, then verifies each index and sourcetype has data. Use when starting Phase 8, resuming it, or re-running the collectors.
disable-model-invocation: true
---

# Setup: Phase 8 SIEM Ingestion

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 8. Run from the repo root.

**Two paths into Splunk:**

| Data | Path | Index / sourcetype |
|---|---|---|
| Cloud-site container logs (authentik, Odoo, cloudflared) | Docker `splunk` logging driver → `https://hec.<domain>` | `app` / `docker:container` |
| On-prem container logs (SQL Server, payroll) | same | `onprem` / `docker:container` |
| Entra sign-ins and directory audits | `scripts/siem/collect.mjs` → HEC | `idp` / `ms:aad:signin`, `ms:aad:audit` |
| authentik events | collector | `idp` / `authentik:event` |
| Okta System Log | collector | `idp` / `OktaIM2:log` |
| Cloudflare account audit and Access logs | collector | `cloudflare` / `cloudflare:audit`, `cloudflare:access` |

`network` (synthetic firewall/VPN) is filled by the simulator (Phase 13), `sut_audit` in Phase 12. OCI audit logs need OCI request signing (SDK or CLI) and are deferred.

**Idempotent by design:** the logging override is switched on by `.env` keys (`set-env.mjs`), `compose up -d` converges, and the collector keeps per-source checkpoints in `local/state/siem-checkpoints.json`, so re-runs send only new events.

**HEC exposure:** `hec.<domain>` is public so the cloud VM can reach on-prem Splunk; only `/services/collector*` matters, and every request needs the HEC token. Splunk web (`siem.`) stays behind Cloudflare Access.

## Steps

### 1. Preconditions

Phases 5–7 are done: the registry has **Cloud VM address**, **On-prem host / network**, and **On-prem `BIND_ADDR`**, and the vault has `On-prem Splunk: HEC token`.

### 2. Publish HEC (`hec.<domain>`)

If the `onprem` tunnel doesn't exist yet, run `/setup-onprem-site` step 7 (at least the `hec.` route; `siem.` with Access is recommended). Through the `cloudflare` MCP, confirm the ingress `hec.<domain>` → `https://splunk:8088` with `noTLSVerify`, and its proxied CNAME.

Record **Splunk HEC URL** = `https://hec.<domain>`. Check: `curl -s https://hec.<domain>/services/collector/health` reports HEC healthy.

### 3. Container logs: on-prem

1. `node scripts/env/set-env.mjs infra/compose/onprem/.env SPLUNK_HEC_URL=https://hec.<domain> COMPOSE_PATH_SEPARATOR=, COMPOSE_FILE=docker-compose.yml,docker-compose.logging.yml`
2. Remote host: copy `docker-compose.logging.yml` and `.env` to `~/ve/onprem/`. Then `docker compose up -d` in the stack folder. Services whose logging changed are recreated (SQL Server and payroll restart briefly; the init jobs re-run idempotently).
3. Confirm with `docker compose ps` that everything is up again.

### 4. Container logs: cloud site

1. `node scripts/env/set-env.mjs infra/compose/cloud/.env SPLUNK_HEC_URL=https://hec.<domain> COMPOSE_PATH_SEPARATOR=, COMPOSE_FILE=docker-compose.yml,docker-compose.logging.yml`
2. `node scripts/env/secret-env.mjs infra/compose/cloud/.env SPLUNK_HEC_TOKEN "Service & API" "On-prem Splunk: HEC token" --kind guid` (restores the existing token from the vault).
3. `scp -i ~/.config/virtual-enterprise/cloud_ssh infra/compose/cloud/docker-compose.yml infra/compose/cloud/docker-compose.logging.yml infra/compose/cloud/.env <Cloud VM address>:/opt/ve/cloud/`, then on the VM `chmod 600 .env && docker compose up -d` (in `/opt/ve/cloud`; services restart briefly).

### 5. Collector credentials

The collector skips any source whose credentials are missing, so add what applies:

1. **Entra:** add Graph **application** permission `AuditLog.Read.All` to `ve-provisioning` and grant admin consent (sign-in logs need Entra ID P1, included in E5).
2. **Cloudflare:** the operator creates an API token `siem-collector` (My Profile → API Tokens → Create custom token): **Account → Account Settings → Read** (audit logs) and **Account → Access: Audit Logs → Read**, scoped to the environment's account. Save it in Passbolt `Service & API` as **`Cloudflare API token: siem-collector`**.
3. authentik and Okta reuse the API tokens from Phase 6.

### 6. Collect

1. `node scripts/siem/collect.mjs --dry-run` prints new-event counts per source and which sources are skipped and why.
2. `node scripts/siem/collect.mjs` sends them (first run: the last 7 days; `--since <days>` changes that). Re-running sends only what's new.

A `FAILED` line names the source and the HTTP error. The usual causes are a missing permission, an expired Okta token, or a Cloudflare endpoint change (the account audit log has a newer v2 API; adapt the source if v1 is gone).

### 7. Verify in Splunk

Search through the REST API (on-prem host `https://<BIND_ADDR>:8089`, or `https://siem-api.<domain>` if tunneled), admin password from the vault:

`curl -sk -u "admin:<password>" https://<host>:8089/services/search/jobs/export -d search="| tstats count where index IN (app, onprem, idp, cloudflare) by index, sourcetype" -d output_mode=csv`

Done when `app` and `onprem` have `docker:container` events and every collector source that wasn't skipped has events.

### 8. Record and report

Record **SIEM sources** = the index/sourcetype pairs with data, and **SIEM collector last run** = now. Report skipped or deferred sources with the reason (OCI audit; anything without credentials). Scheduling the collector with the simulator happens in Phase 13; until then, re-run step 6 when fresh data is needed.

Next step: **Phase 9: SaaS Accounts**.
