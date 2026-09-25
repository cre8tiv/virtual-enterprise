---
name: setup-onprem-site
description: Run SETUP.md Phase 5b for the virtual enterprise. Deploys the on-prem site (SQL Server 2022 Developer with the Operations database and read-only sut_reader login, Splunk Enterprise with the ve indexes and HEC) on an x86 Docker host (this machine or a remote host over SSH), syncs its secrets with the vault, smoke-tests SQL, Splunk REST, and HEC end to end, and applies the Splunk developer license. Optional Cloudflare Tunnel for direct Splunk access. Use when starting Phase 5b or resuming it.
disable-model-invocation: true
---

# Setup: Phase 5b On-Prem Site

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 5b. Run from the repo root; `compose` below means `docker compose` in `infra/compose/onprem/` on the chosen host. Phases 5a and 5b are independent.

**Idempotent by design:** secrets sync through `secret-env.mjs` (never regenerated once set), `compose up -d` converges, the SQL init scripts are idempotent, and the license step checks what's installed first.

**Secret hygiene:** secrets live in `infra/compose/onprem/.env` (gitignored) and the vault. Pass them to commands with `$(grep '^KEY=' infra/compose/onprem/.env | cut -d= -f2-)`; keep them out of replies.

Windows notes: run the curl checks in Git Bash with `curl` (in PowerShell, `curl` is an alias; use `curl.exe`). Prefix `docker compose exec ... /opt/...` with `MSYS_NO_PATHCONV=1` in Git Bash, and use `cygpath -m` for host paths passed to `docker compose cp`.

## Steps

### 1. Preconditions

1. `local/registry.md` has **Domain** (Phase 1); `node scripts/vault/vault.mjs whoami` prints `ok` (Phase 2).

### 2. Host

If the registry has **On-prem host / network**, confirm it with the operator and go to step 3. Otherwise offer:

- **This machine** (quick start; only up while the machine is): requires `docker info --format '{{.Architecture}}'` = `x86_64` and roughly 12 GB+ for Docker (`docker info --format '{{.MemTotal}}'`; on Docker Desktop raise the memory limit if needed). SQL Server and Splunk Enterprise don't run on arm64.
- **A dedicated x86_64 Linux host or VM** on a private network with no inbound from the internet (e.g. a VM on Visual Studio subscription Azure credits with auto-shutdown, or a Hyper-V/physical box): ~4 vCPU, 16 GB RAM, 100+ GB disk, Docker + Compose installed, reachable by SSH from this machine. Verify with `ssh <host> "docker info --format '{{.Architecture}} {{.MemTotal}}'"`.

`BIND_ADDR`: `127.0.0.1` if the SUT's gateway will run on the same host, otherwise the host's LAN address.

Record **On-prem host / network** and **On-prem `BIND_ADDR`**.

### 3. Configuration and secrets

1. `node scripts/env/set-env.mjs infra/compose/onprem/.env BIND_ADDR=<addr>` (creates `.env` from `.env.example`).
2. Sync each secret (generated once, vault first):
   - `node scripts/env/secret-env.mjs infra/compose/onprem/.env MSSQL_SA_PASSWORD "Service & API" "On-prem SQL Server: sa" --username sa`
   - `node scripts/env/secret-env.mjs infra/compose/onprem/.env SUT_READER_PASSWORD "Service & API" "On-prem SQL Server: sut_reader" --username sut_reader`
   - `node scripts/env/secret-env.mjs infra/compose/onprem/.env SPLUNK_PASSWORD "Service & API" "On-prem Splunk: admin" --username admin`
   - `node scripts/env/secret-env.mjs infra/compose/onprem/.env SPLUNK_HEC_TOKEN "Service & API" "On-prem Splunk: HEC token" --kind guid`

   A "differ" error means the `.env` and the vault disagree. SQL Server and Splunk keep the password from their first start, so ask which one is live before resolving.

Done when all four print `kept`, `vaulted`, `restored`, or `generated`.

### 4. Deploy

- **This machine:** `compose up -d`.
- **Remote host:** copy the stack, then start it:
  `ssh <host> "mkdir -p ~/ve"` → `scp -r infra/compose/onprem <host>:~/ve/` → `ssh <host> "chmod 600 ~/ve/onprem/.env && cd ~/ve/onprem && docker compose up -d"`. Run the later `compose` commands through `ssh <host> "cd ~/ve/onprem && ..."`.

Wait until `compose ps -a` shows `sqlserver` healthy, `sqlserver-init` exited with code 0, and `splunk` healthy (Splunk's first start takes several minutes). If `sqlserver-init` failed, show its logs (`compose logs sqlserver-init`).

### 5. Smoke tests

Run on the host from the stack folder (`infra/compose/onprem/` locally, `~/ve/onprem` remotely), with the secret read from `.env` into each command:

1. **SQL, read-only login works:** `compose exec -T -e P="$(grep '^SUT_READER_PASSWORD=' .env | cut -d= -f2-)" sqlserver bash -c '/opt/mssql-tools18/bin/sqlcmd -S localhost -U sut_reader -P "$P" -C -d Operations -h -1 -Q "SET NOCOUNT ON; SELECT DB_NAME()"'` prints `Operations`.
2. **SQL, read-only is enforced:** the same with `-Q "CREATE TABLE smoke (x int)"` must fail with a permission error.
3. **Splunk REST:** `curl -sk -u "admin:$(grep '^SPLUNK_PASSWORD=' .env | cut -d= -f2-)" "https://<BIND_ADDR>:8089/services/server/info?output_mode=json"` returns JSON with the version.
4. **HEC in, search out:** `curl -sk "https://<BIND_ADDR>:8088/services/collector/health"` is healthy; post `{"event":"ve phase5b smoke","index":"onprem","sourcetype":"ve:smoke"}` to `/services/collector/event` with header `Authorization: Splunk <HEC token>` (expect `"text":"Success"`); after a few seconds `curl -sk -u admin:... https://<BIND_ADDR>:8089/services/search/jobs/export -d search="search index=onprem sourcetype=ve:smoke | head 1" -d output_mode=json` returns the event. An "Incorrect index" reply means the HEC token's allowed indexes exclude `onprem`; add it under Settings → Data inputs → HTTP Event Collector.

Record **SQL Server version** (first line of `SELECT @@VERSION` run as `sa`) and **Splunk version**.

Done when all four checks pass.

### 6. Splunk developer license

1. Check what's installed: `curl -sk -u admin:... "https://<BIND_ADDR>:8089/services/licenser/licenses?output_mode=json"`. A developer license present → record its expiry and skip to step 7. Without one, Splunk runs a 60-day Enterprise trial and then drops to Free, which has no authentication. Record the trial end as the renewal date meanwhile.
2. If **Email Routing mode** is `per-address rules`, make sure `splunk-admin@svc.<domain>` has a forwarding rule. The operator requests a Splunk developer license with `splunk-admin@svc.<domain>` and saves the license file to `~/.config/virtual-enterprise/splunk-dev.lic` (remote host: `scp` it to `~/ve/`).
3. Apply it: `compose cp <license path> splunk:/tmp/splunk-dev.lic`, then `compose exec -T -u splunk splunk /opt/splunk/bin/splunk add licenses /tmp/splunk-dev.lic -auth "admin:<password>"`, then `compose restart splunk` and wait for healthy.
4. Re-check the licenses endpoint and record the expiry in the Renewal column of **Splunk version**.

### 7. Optional: direct access through Cloudflare Tunnel

Only if the operator wants Splunk reachable without the SUT's gateway (SQL Server stays gateway-only: raw TCP through a tunnel needs `cloudflared` on the client).

1. The operator creates tunnel `onprem` in Zero Trust (as in Phase 5a) and pastes its token into `infra/compose/onprem/.env` as `CLOUDFLARE_TUNNEL_TOKEN`. Sync it: `secret-env.mjs ... CLOUDFLARE_TUNNEL_TOKEN "Service & API" "Cloudflare tunnel: onprem"` (copy `.env` to the remote host again if remote).
2. `compose --profile tunnel up -d`.
3. Through the `cloudflare` MCP: ingress `siem.<domain>` → `http://splunk:8000`, `siem-api.<domain>` → `https://splunk:8089`, `hec.<domain>` → `https://splunk:8088` (both with `noTLSVerify`), ending with `http_status:404`; proxied CNAMEs to `<tunnel ID>.cfargotunnel.com`; a Cloudflare Access application protecting `siem.<domain>` for the operator's email.
4. Record the tunnel ID in **Cloudflare Tunnel IDs (cloud / onprem)** and **Splunk URL (if tunneled)**.

### 8. Report

Summarize the host, versions, smoke-test results, license state and expiry, and tunnel (if any). Then tell the operator how to sign in, in plain steps:

- **Splunk web UI:** `http://<BIND_ADDR>:8000` (it may redirect to HTTPS; accept the self-signed certificate). Username `admin`. The password is in Passbolt, folder `Service & API`, item **`On-prem Splunk: admin`** (also `SPLUNK_PASSWORD` in `infra/compose/onprem/.env`). Splunk's welcome tour can be skipped. With `BIND_ADDR=127.0.0.1` the UI works only from the host itself, unless the tunnel from step 7 exists (`https://siem.<domain>`, behind Cloudflare Access).
- **Splunk REST API:** `https://<BIND_ADDR>:8089`, same `admin` account.
- **Splunk HEC (event ingest):** `https://<BIND_ADDR>:8088`, no username; it uses the token in Passbolt item **`On-prem Splunk: HEC token`** (`Authorization: Splunk <token>`).
- **SQL Server:** `<BIND_ADDR>,1433`. `sa` (item **`On-prem SQL Server: sa`**) is for administration only; the SUT reads with `sut_reader` (item **`On-prem SQL Server: sut_reader`**), which is read-only on `Operations`.
- **Try it:** search `index=onprem sourcetype=ve:smoke` in Splunk to see the smoke-test event.

The `Operations` tables are loaded in Phase 10; Splunk ingestion is wired in Phase 8. Next step: **Phase 5a** (`/setup-cloud-site`) if not done, else **Phase 6: Workforce Identity**.
