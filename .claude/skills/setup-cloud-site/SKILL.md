---
name: setup-cloud-site
description: Run SETUP.md Phase 5a for the virtual enterprise. Provisions the cloud site on OCI Always Free with Terraform (Ampere A1 VM, closed inbound, zero-spend budget alert), bootstraps Docker, and connects the outbound-only Cloudflare Tunnel "cloud" that later phases publish services through. Use when starting Phase 5a, resuming it, or re-applying after a change (e.g. a new admin IP).
disable-model-invocation: true
---

# Setup: Phase 5a Cloud Site (OCI)

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 5a. Run from the repo root. Phases 5a and 5b are independent.

**Idempotent by design:** Terraform converges to `infra/oci/*.tf` (plan first, apply on yes), secrets sync through `secret-env.mjs`, and tunnel/DNS state is read through the `cloudflare` MCP before any change.

**Secret hygiene:** the OCI API private key, the SSH private key, and the tunnel token live in files outside the repo or in gitignored `.env` files, with copies in the vault. Move them with command substitution; keep them out of replies. The operator creates the tunnel in the dashboard and pastes its token into the `.env` file, so the token never enters the conversation.

Files (outside the repo, `~/.config/virtual-enterprise/`): `oci_api_key.pem` (Terraform's API key), `cloud_ssh` / `cloud_ssh.pub` (VM SSH key). In the repo (gitignored): `infra/oci/terraform.tfvars`, `infra/oci/terraform.tfstate`, `infra/compose/cloud/.env`.

Windows notes: run `ssh`, `scp`, and `terraform` from the PowerShell tool after refreshing PATH (`$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')`). OpenSSH refuses a private key readable by others; fix with `icacls <key> /inheritance:r /grant:r "$($env:USERNAME):R"`.

## Steps

### 1. Preconditions

1. `local/registry.md` has **Domain**, **Operator mailbox**, **Cloudflare account ID**, **Email Routing mode** (Phases 0–3).
2. `node scripts/vault/vault.mjs whoami` prints `ok`; `terraform version` and `ssh -V` work.

### 2. OCI account (operator)

Skip to step 3 if the registry has **OCI tenancy / region**.

1. If **Email Routing mode** is `per-address rules`, make sure `oci-admin@svc.<domain>` has a forwarding rule (`/setup-email-routing` step 7).
2. The operator signs up for OCI Free Tier (https://signup.cloud.oracle.com/) with `oci-admin@svc.<domain>` (card verification required), enables MFA, and stores the credentials in Passbolt `Break-glass`.
3. **Home region is permanent**, and Always Free A1 capacity exists only there. Help the operator pick one near them that isn't chronically out of A1 capacity (smaller regions often have more).
4. Recommend upgrading to **Pay As You Go** (Billing → Upgrade): Always Free resources stay $0, but idle Always Free instances are reclaimed on free accounts, and PAYG also gets A1 capacity more easily. The Terraform budget alert (step 5) reports any spend.
5. Record **OCI tenancy / region** = `<tenancy OCID> / <region identifier>` (Profile → Tenancy; region identifier like `us-ashburn-1`).

### 3. Keys

1. **API key:** if `~/.config/virtual-enterprise/oci_api_key.pem` doesn't exist, the operator opens Profile → My profile → API keys → Add API key → **Generate API key pair**, downloads the private key to that path, clicks Add, and reads you the configuration preview (user OCID, fingerprint; not secret). Keep a vault copy:
   `node scripts/vault/vault.mjs upsert "Service & API" "OCI API key: terraform" --username <user OCID> --description "fingerprint <fp>" --password "<base64 of the .pem>"` (PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\.config\virtual-enterprise\oci_api_key.pem"))`; bash: `base64 -w0 <file>`).
2. **SSH key:** if `~/.config/virtual-enterprise/cloud_ssh` doesn't exist, create it with an **empty** passphrase from Git Bash (`ssh-keygen -t ed25519 -N '' -C ve-cloud -f ~/.config/virtual-enterprise/cloud_ssh`). Don't create it from PowerShell: `-N '""'` there sets the passphrase to the two literal quote characters, the key then can't be used non-interactively, and the VM rejects it with `Permission denied (publickey)`. Confirm it has no passphrase with `ssh-keygen -y -P '' -f <key>` (it must print the public key). Restrict its permissions, then vault a base64 copy as `"SSH key: cloud site"` in `Service & API`. To repair a key that already has a stray passphrase, grant write access temporarily and run `cmd /c "ssh-keygen -p -P ""\""\"""" -N """" -f ""<key>"""` (the public key on the VM stays valid), then relock and re-vault it with `--rotate`.

Done when both key files exist and both vault resources exist.

### 4. Terraform variables

Write `infra/oci/terraform.tfvars` from `terraform.tfvars.example` (non-secret values only): tenancy/user OCID, fingerprint, key paths, region, `budget_alert_email` = operator mailbox.

**SSH access:** get the operator's public IP (`curl -s https://1.1.1.1/cdn-cgi/trace`, the `ip=` line) and ask whether to allow SSH from it during setup (`admin_cidrs = ["<ip>/32"]`). Later phases deploy stacks over SSH; `[]` closes inbound entirely. When the IP changes, update the list and re-apply.

If the file exists, change only what differs, and show the operator any change.

### 5. Plan and apply

1. `terraform -chdir=infra/oci init -input=false`
2. `terraform -chdir=infra/oci plan -input=false -out=tfplan`. Summarize: compartment, budget and alert, VCN/subnet/security list, VM (A1 4 OCPU / 24 GB, Ubuntu 24.04), and no Autonomous DB (enabled in Phase 10). A plan with no changes means the site already matches.
3. On an explicit yes: `terraform -chdir=infra/oci apply -input=false tfplan`.
   - **"Out of host capacity"** for A1 is common. If the region has more than one availability domain, set `availability_domain_index` to 1 or 2 and plan again. Otherwise retry later (capacity frees up during the day). PAYG accounts get capacity more readily.
4. `terraform -chdir=infra/oci output` → record **OCI VMs** = `ve-cloud-1 (<public IP>)`.
5. The state file contains resource IDs (and the Autonomous DB password once enabled). Remind the operator to keep a copy with the vault backups.

Done when `plan` reports no changes.

### 6. Bootstrap check

`ssh -i ~/.config/virtual-enterprise/cloud_ssh -o StrictHostKeyChecking=accept-new ubuntu@<ip> "cloud-init status --wait; docker version --format '{{.Server.Version}}'; docker compose version --short"`

First boot takes several minutes (package upgrade). If SSH times out, check that `admin_cidrs` contains the current IP.

Done when Docker and Compose versions print.

### 7. Tunnel `cloud`

1. Use the `cloudflare` MCP to look for a tunnel named `cloud` in the account.
2. **Missing:** the operator creates it (Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared → name `cloud`), copies the token from the install command (the string after `--token`), and pastes it into `infra/compose/cloud/.env` as `CLOUDFLARE_TUNNEL_TOKEN=...` (create the file from `.env.example`). They skip the "route traffic" step; hostnames come in later phases. **Validate the value without printing it** before syncing: the token is one line of about 180 characters starting `eyJ`, with no spaces or quotes. A 36-character UUID is the tunnel ID, a common mix-up, and cloudflared then loops on "Provided Tunnel token is not valid". If the wrong value was already vaulted, `secret-env.mjs` stops on the mismatch; fix the vault item with `vault.mjs upsert ... --rotate` after the operator corrects `.env`.
3. Sync the token with the vault: `node scripts/env/secret-env.mjs infra/compose/cloud/.env CLOUDFLARE_TUNNEL_TOKEN "Service & API" "Cloudflare tunnel: cloud"`. This also restores the `.env` value from the vault on a fresh clone.
4. Deploy:
   `ssh ... ubuntu@<ip> "mkdir -p /opt/ve/cloud"`
   `scp -i ~/.config/virtual-enterprise/cloud_ssh infra/compose/cloud/docker-compose.yml infra/compose/cloud/.env ubuntu@<ip>:/opt/ve/cloud/`
   `ssh ... ubuntu@<ip> "chmod 600 /opt/ve/cloud/.env && cd /opt/ve/cloud && docker compose up -d"`
5. Verify the connector: the MCP shows the tunnel healthy with active connections, or `docker compose logs --tail 20 cloudflared` on the VM shows "Registered tunnel connection".
6. **End-to-end check** (the machine's own resolver may not know the new name for several minutes; test with `curl --doh-url https://cloudflare-dns.com/dns-query <url>` instead of waiting): through the MCP, add the ingress rule `hello-cloud.<domain>` → `hello_world` (the rule list must end with the catch-all `http_status:404`) and a proxied CNAME `hello-cloud` → `<tunnel ID>.cfargotunnel.com`. Confirm `https://hello-cloud.<domain>` answers, then remove the rule and the DNS record.
7. Record the tunnel ID in **Cloudflare Tunnel IDs (cloud / onprem)**.

Done when the connector is healthy and the hello check passed.

### 8. Report

Summarize the VM (shape, IP, AD), the SSH policy (`admin_cidrs`), the tunnel, and the budget alert. Note what later phases add: authentik (Phase 6) and Odoo (Phase 7) join `infra/compose/cloud/` and get public hostnames on this tunnel; the Autonomous DB (`create_autonomous_db`) comes with the data loads in Phase 10.

Next step: **Phase 5b** (`/setup-onprem-site`) if not done, else **Phase 6: Workforce Identity**.
