# Setup Runbook

Ordered, repeatable steps to stand up an instance of the virtual enterprise described in [DESIGN.md](DESIGN.md). Written so each phase can later be automated.

**Conventions**

- `<company>` / `<domain>`: the fictional company's name and domain, chosen in Phase 1.
- **Operator**: whoever is deploying this instance. **SUT**: the system under test.
- **[manual]**: requires a human (CAPTCHA, payment verification, eligibility, email confirmation). **[script]**: candidate for automation.
- **Record:** non-secret values to capture in `local/registry.md` (gitignored; template at the end of this file). **Secrets go in the operator vault only**, never in the repo.
- Complete phases in order; later phases depend on earlier outputs.
- **Idempotent:** every [script] step and every setup skill reads current state first (the registry and the live system), skips what is already done, and verifies after acting. Re-running a phase is always safe and never creates duplicates.

**Email address rule:** all vendor/app sign-ups use `<system>-admin@svc.<domain>` from day one, **never** the root domain. Root-domain MX moves to M365 in Phase 4; `svc.` addresses keep working through that cutover.

**Break-glass rule:** the Cloudflare account is owned by an operator mailbox **outside** `<domain>`. Mail to `<domain>` flows through Cloudflare, so a Cloudflare lockout would otherwise block its own recovery.

---
## Agent tooling (MCP servers)

The repo's `.mcp.json` defines project MCP servers for agent-assisted setup. It contains **no secrets**: servers authenticate via OAuth on first use, or read tokens from environment variables. Claude Code asks each user to approve project servers on first launch.

| Server | Used in | Auth | Must point at |
|---|---|---|---|
| `cloudflare` | Phases 1, 2, 5, 11 (DNS, Email Routing, Tunnel, Workers) | OAuth | The environment's Cloudflare account |
| `cloudflare-docs` | Any | None | n/a |
| `godaddy` | Phase 1 (public domain availability and suggestions; read-only) | None | n/a |
| `supabase` | Phases 9–11 (migrations, Edge Functions, SQL, logs) | OAuth | The environment's Supabase org |
| `microsoft-learn` | Phases 4, 6 (Graph/Entra docs) | None | n/a |
| `m365-sandbox` | Optional, ad-hoc sandbox queries (SharePoint, Teams). Provisioning uses `scripts/m365/` instead. | `m365 login` (CLI for Microsoft 365) | **The E5 sandbox tenant** |
| `stripe` | Phases 9–10 (test-mode data) | OAuth | The environment's Stripe account, test mode |
| `shopify-dev` | Phases 10–11 (API docs, GraphQL validation) | None | n/a |

- [ ] **[manual]** Launch `claude` in the repo and approve the project servers.
- [ ] **[manual]** Complete OAuth for `cloudflare`, `supabase`, `stripe` **while signed in to the environment's accounts**, not the operator's production accounts.
- [ ] **[manual]** `m365-sandbox` uses the CLI for Microsoft 365 (`npm i -g @pnp/cli-microsoft365`). Create a named connection to the sandbox (`m365 login` with the sandbox admin, then `m365 connection set --name <company>-sandbox`, or equivalent).
- [ ] **[manual]** Add the SUT's own MCP server, if any, with `claude mcp add --scope local ...`. It is **not** committed.

**Tenant safety:**

- CLI for Microsoft 365 keeps **one active connection per OS user**, shared by every MCP server and shell that uses it. If a user-scope M365 server or your own shell is logged in to a production tenant, `m365-sandbox` acts on that tenant. Before any write, confirm `m365 status` shows the sandbox tenant ID from `local/registry.md`. Provisioning scripts pass the tenant ID explicitly and refuse to run otherwise.
- Prefer environment-specific accounts for every OAuth server. If your browser session belongs to a production account, use a separate browser profile when completing OAuth.

**Windows:** stdio servers launched with `npx` may need the `cmd /c` wrapper on native Windows. Override locally without editing the shared file, e.g. `claude mcp add --scope local shopify-dev -- cmd /c npx -y @shopify/dev-mcp@latest` (local scope takes precedence over project scope).


## Phase 0: Prerequisites

**Agent-assisted:** run the `/setup-prerequisites` skill in Claude Code; it performs the steps below and asks before installing anything.

- [ ] **[manual]** Choose an operator mailbox outside `<domain>` (a team/distribution address, not personal). It owns only break-glass accounts. If you don't want to use your company email, sign up for a email from a free provider to start with.
- [ ] **[manual]** Decide owners (primary + backup) for break-glass accounts.

- [ ] **[script]** Check required tools (git, Docker + Compose with the daemon running, Node.js/npm, Terraform, `go-passbolt-cli`, CLI for Microsoft 365). Check-only by default; add the install flag to install what's missing (winget/Chocolatey, Homebrew, apt/dnf, or direct download):
  - Windows: `powershell -ExecutionPolicy Bypass -File scripts/prereqs/prereqs.ps1 [-Install]`
  - macOS/Linux: `bash scripts/prereqs/prereqs.sh [--install]`
- [ ] **[manual]** Install the Passbolt browser extension.
- [ ] **[script]** Create `local/` (gitignored) and copy the registry template into `local/registry.md`.
- **Bootstrap secrets:** until the vault exists (Phase 2), keep credentials in your personal password manager. Phase 2 moves them into the vault.
- **Record:** operator mailbox, owners.
- [ ] **[manual]** Create a Cloudflare account with the operator mailbox and prepare it for Registrar (Phase 1 registers through the Registrar API):
  - enable 2FA (hardware key or TOTP); keep the login and recovery codes in your personal password manager;
  - add a default payment method;
  - set the default registrant contact;
  - accept the Domain Registration Agreement (Registrar → registrations page).
- [ ] **[manual]** Complete OAuth for the `cloudflare` MCP server with this account, granting Registrar write and DNS/zone edit.

## Phase 1: Company Name & Domain

**Agent-assisted:** run the `/setup-company-domain` skill; it performs the steps below, resumes where a previous run stopped, and asks before registering.

- [ ] Shortlist fictional company names (company profile: DESIGN.md §2). Working notes go in `local/names.md`.
- [ ] For each candidate, confirm it is not a real business: web search, trademark search (USPTO / EUIPO), business registries (e.g. OpenCorporates). Pick one **clear** name.
- [ ] **[script]** Synthesize domain candidates; quick-filter with the `godaddy` MCP; confirm availability and at-cost price with Cloudflare Registrar **check** (authoritative: the domain must be registrable at Cloudflare).
- [ ] **[script]** After explicit operator confirmation (registrations are non-refundable): confirm the account doesn't already hold the domain, then register via Cloudflare Registrar with **auto-renew on** (the API defaults to off); WHOIS privacy (redaction) is the default.
- [ ] **[script]** Verify the registration and the DNS zone (create the zone if missing).
- [ ] **[script]** Write derived config into gitignored `.env` files (created from each `.env.example`, which stays a generic template): `apps/storefront/.env` (`COMPANY_NAME`, `SITE_URL=https://www.<domain>`), `infra/compose/vault/.env` (`APP_FULL_BASE_URL=https://vault.<domain>`). Replace `<domain>` placeholders in `local/registry.md`.
- **Record:** company name, `<domain>`, Cloudflare account ID, zone ID, domain expiry.

## Phase 2: Operator Vault (Passbolt CE)

**Agent-assisted:** run the `/setup-vault` skill; it performs the [script] steps, verifies each [manual] step, and resumes where a previous run stopped.

Stack: `infra/compose/vault/` (Passbolt Community Edition + MariaDB). It starts on the operator's machine and can later move to any Docker host by backup/restore.

**The vault URL is permanent:** `https://vault.<domain>` from day one. Passbolt ties each user's browser extension to the server URL, so changing it later means reconfiguring every user.

- [ ] **[script]** Choose the bind address: `127.0.0.1` if port 443 is free there, otherwise another loopback address such as `127.0.0.2` (`BIND_ADDR` in `infra/compose/vault/.env`; macOS needs `sudo ifconfig lo0 alias 127.0.0.2`). The hosts file can't carry a port, so a different address keeps the URL port-less and portable. Only port 443 is published; port 80 isn't needed.
- [ ] **[manual]** Point `vault.<domain>` at that address in the hosts file (`<BIND_ADDR>  vault.<domain>`; Windows: `C:\Windows\System32\drivers\etc\hosts`, macOS/Linux: `/etc/hosts`). Requires admin rights. No public DNS record yet.
- [ ] **[script]** Generate `PASSBOLT_DB_PASSWORD` in `infra/compose/vault/.env` only if empty (`scripts/env/set-env.mjs ... --if-empty`; changing it after initialization breaks the stack).
- [ ] **[manual]** Create a Cloudflare API token `vault-acme` (dashboard → My Profile → API Tokens → "Edit zone DNS" template): **Zone:Read + DNS:Edit**, limited to the `<domain>` zone. Paste it into `infra/compose/vault/.env` as `CLOUDFLARE_DNS_API_TOKEN`. Traefik uses it to get a trusted Let's Encrypt certificate for `vault.<domain>` via the DNS-01 challenge: no public DNS record, no inbound port, and no changes to local trust stores. A trusted certificate is required; with a self-signed one, browsers and the extension treat the vault as insecure and TOTP enrollment fails.
- [ ] **[script]** `docker compose up -d` (Passbolt, MariaDB, Traefik). Confirm the certificate is trusted: `https://vault.<domain>` opens with no warning, issued by Let's Encrypt (first issuance takes a minute or two; see `docker compose logs traefik`). Then run the healthcheck:
  `docker compose exec passbolt su -s /bin/bash -c '/usr/share/php/passbolt/bin/cake passbolt healthcheck' www-data`
  Pass the server key fingerprint into the exec (`-e PASSBOLT_GPG_SERVER_KEY_FINGERPRINT=<fp from /auth/verify.json>` plus `su -w PASSBOLT_GPG_SERVER_KEY_FINGERPRINT`), or the GPG and metadata checks fail spuriously. Expect only the missing-SMTP failure and "not configured to force SSL" (Traefik terminates TLS). The first minute after start can show "table doesn't exist" while migrations run.
- [ ] **[script]** Register the first admin (no email needed; prints a registration URL):
  `docker compose exec passbolt su -s /bin/bash -c '/usr/share/php/passbolt/bin/cake passbolt register_user -u <operator-mailbox> -f <first> -l <last> -r admin' www-data`
- [ ] **[manual]** Open the registration URL; install the Passbolt browser extension; set a strong passphrase.
- [ ] **[manual]** Download the **recovery kit** and store it, with the passphrase, **outside Passbolt** (offline and/or personal password manager). This is the vault's break-glass.
- [ ] **[manual]** Enable TOTP MFA (Administration → Multi Factor Authentication) and enroll the admin.
- [ ] **[script]** Register the automation user `automation@svc.<domain>` (role `user`). **[manual]** Complete its registration in a separate browser profile; export its private key to `~/.config/virtual-enterprise/automation.asc` and write its passphrase to `~/.config/virtual-enterprise/automation.passphrase` (user-only permissions).
  - Signing in from a new browser or profile asks for an emailed link, and SMTP doesn't exist yet. Get a recovery link from the server instead: `docker compose exec passbolt su -s /bin/bash -c '/usr/share/php/passbolt/bin/cake passbolt recover_user -u <email>' www-data`, then import the private key and enter the passphrase.
- [ ] **[manual]** Administration → Organisation Settings → Encrypted Metadata: turn on **legacy cleartext metadata** and make it the **default metadata type** (leave encrypted metadata enabled). `go-passbolt-cli` can't trust the server-issued metadata key ([go-passbolt-cli #79](https://github.com/passbolt/go-passbolt-cli/issues/79)), so v5 items it creates can't be shared with the admin, and the admin would never see them. Do this before the automation user creates any item.
- [ ] **[script]** Configure `go-passbolt-cli` with a project config (`passbolt configure --config ~/.config/virtual-enterprise/passbolt.toml --serverAddress https://vault.<domain> --userPrivateKeyFile ...`; TLS verification stays on); verify with `node scripts/vault/vault.mjs whoami`.
- [ ] **[script]** Folders, created by the automation user with the admin as Owner (`vault.mjs ensure-folder <name> --share-owner <operator-mailbox>`):
  - `Vendor admins`: SaaS/admin accounts (`*-admin@svc.<domain>`)
  - `Personas`: employee accounts (M365/IdP users)
  - `Customers`: storefront customer test accounts
  - `Service & API`: API tokens, OAuth clients, HEC tokens, DB users
- [ ] **[manual]** Create `Break-glass` (Cloudflare, M365 global admin, OCI root, automation passphrase) in the UI, shared with no one, so the automation user never has access.
- [ ] Move the bootstrap credentials into the vault: `PASSBOLT_DB_PASSWORD` and the `vault-acme` token → `Service & API` (**[script]** `vault.mjs upsert`); Cloudflare login + 2FA recovery codes → `Break-glass` (**[manual]**).
- **Offline fallback:** if Let's Encrypt isn't an option, mkcert can issue a locally trusted certificate (it installs its own CA into this machine's trust stores, so only this machine trusts it). Replace Traefik's resolver with a static certificate in `traefik/dynamic.yml`.
- [ ] **[script]** `bash infra/compose/vault/backup.sh <dir-outside-repo>`; verify it; store the backup (DB dump + server GPG keys + JWT keys) encrypted/offline. Repeat after significant changes and monthly (Phase 14).
- SMTP is configured in Phase 4. Until then, invites and email-based recovery don't work; that's fine for a single operator.
- **Moving the vault later:** run `backup.sh` on the old host, `restore.sh` on the new host with the same `APP_FULL_BASE_URL`, then repoint DNS/hosts (e.g. a Cloudflare Tunnel hostname protected by Cloudflare Access). Users don't re-enroll because the URL is unchanged.
- **Record:** vault URL, current host, backup location, automation user.

## Phase 3: Email Catch-All (Cloudflare Email Routing)

**Agent-assisted:** run the `/setup-email-routing` skill; it configures routing through the `cloudflare` MCP, waits for the two manual steps, and resumes where a previous run stopped.

- [ ] **[script]** Enable Email Routing on subdomain `svc.<domain>` **only**; Cloudflare adds and locks its MX + SPF records. The root domain's MX is reserved for M365 (Phase 4).
- [ ] **[script]** Add the operator mailbox as a destination address. **[manual]** Click the verification link Cloudflare sends.
- [ ] **[script]** Set the zone catch-all to forward to the operator mailbox, and add literal rules for addresses already in use (`dmarc@svc.<domain>`, `automation@svc.<domain>`).
- [ ] **[script]** Add DMARC if absent: `_dmarc.<domain>  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@svc.<domain>"`.
- [ ] **[manual]** Send a test email to a random `phase3-test-…@svc.<domain>` address from a different mailbox and confirm it arrives.
  - If it doesn't arrive but `dmarc@svc.<domain>` does, the catch-all doesn't cover the subdomain: switch to **per-address rules**, creating a literal rule for each `<system>-admin@svc.<domain>` before signing up with it (re-run the skill).
- Cloudflare API tokens for scripts are created per purpose when a phase first needs one (e.g. `vault-acme` in Phase 2), each with least privilege. Agent work uses the `cloudflare` MCP.
- **Record:** routing destination, Email Routing mode (`catch-all` or `per-address rules`), apex routing state if it had to be enabled.

## Phase 4: Microsoft 365 E5 Developer Sandbox

**Agent-assisted:** run the `/setup-m365` skill; it runs the scripts, creates DNS records through the `cloudflare` MCP, guides the portal steps, and resumes where a previous run stopped. Re-run it after editing `canonical/org/` to re-sync the tenant.

Admin portals used in this phase: [Entra admin center](https://entra.microsoft.com/) (app registration, roles, tenant ID), [Microsoft Defender](https://security.microsoft.com/) (DKIM), [Microsoft 365 admin center](https://admin.cloud.microsoft/) (users, licenses, shared mailboxes), [Exchange admin center](https://admin.cloud.microsoft/exchange) (message trace).

Graph work runs through `scripts/m365/` as the `ve-provisioning` app registered **inside the sandbox**, never through the `m365` CLI, whose single active connection is shared with the operator's other tenants. Every script checks the token's tenant against **M365 tenant ID** in the registry.

- [ ] **[manual]** Confirm eligibility (Visual Studio Pro/Enterprise subscription or partner benefit). Join the M365 Developer Program with `m365-admin@svc.<domain>` and create a **configurable (empty)** E5 sandbox (see "Users" below). Store the global admin credentials (`admin@<tenant>.onmicrosoft.com`) in `Break-glass`; record tenant ID, tenant name, sandbox expiry, and the Developer Program account email.
  - **Existing sandbox:** adopt it, even an instant one with sample users or one registered under another email. Recreating isn't practical (a deleted sandbox means a 60–90 day wait; a new account must itself be eligible). The cleanup step below removes the samples. If the program's email is a mailbox inside the sandbox, change the profile's contact email to `m365-admin@svc.<domain>` if possible; otherwise keep that mailbox licensed so renewal warnings arrive.
- [ ] **[manual]** Register the Entra app `ve-provisioning` (single tenant; Graph application permissions `User.ReadWrite.All`, `Group.ReadWrite.All`, `Directory.ReadWrite.All`, `Domain.ReadWrite.All`, `Organization.Read.All`, plus the Phase 6a set `Policy.ReadWrite.AuthenticationMethod`, `UserAuthenticationMethod.ReadWrite.All`, `Policy.ReadWrite.ConditionalAccess`, `Policy.Read.All`, `Application.Read.All`, and `User.DeleteRestore.All`, so nothing has to be added later; admin consent; client secret). Also assign it the **User Administrator** directory role (scope Directory): without it, Graph refuses password resets (`--rotate`) with 403. If `Password Administrator` fails with "role not found", use User Administrator. Save it in Passbolt `Service & API` as `Entra app: ve-provisioning` (username = client ID, password = secret).
- [ ] **[script]** Add and verify `<domain>` (`node scripts/m365/domain.mjs add|status|verify|default`); the verification TXT record goes into Cloudflare.
- [ ] **[script]** If **Email Routing apex** is `enabled` in the registry, disable Email Routing for the apex only (keep `svc.<domain>`) so its locked root MX records are released.
- [ ] **[script]** Create the service records from `domain.mjs status` in Cloudflare, **DNS only**: root MX, SPF, autodiscover, plus Teams and Intune records. Root-domain mail cuts over to Exchange here; `svc.` stays on Cloudflare.
- [ ] **[manual]** DKIM: read the two selector CNAMEs in the Defender portal (the **[script]** step creates them in Cloudflare), then enable signing.
- [ ] **[script]** Remove objects the org model doesn't manage (instant-sandbox sample users, Microsoft 365 groups and their Teams/sites): `node scripts/m365/cleanup.mjs` (plan), then `--apply` after reviewing the list. Personas, directory-role holders (the admin), and `ops@` are always protected; deleted objects are purged so licenses and names free up immediately.
- [ ] **[script]** Provision the org model (see below): `node scripts/m365/provision.mjs` (plan), then `--apply`. If the sandbox admin holds an E5 license, remove it first so all 25 personas get one, unless the admin's mailbox receives the Developer Program's renewal warnings. The sandbox may list the E5 pack as `DEVELOPERPACK_V2_E5`; the script accepts both names. New users may receive a direct license automatically, and assigning the license to `app-m365` may not stick, which leaves one harmless pending change in the plan. All 25 personas holding a license is what matters.
- [ ] **[manual]** Create shared mailbox `ops@<domain>` (full access: `it-director`, `sysadmin`). Test by sending external mail to `ops+phase4@<domain>` (proves root delivery and plus-addressing). Verify with Exchange admin center → Mail flow → Message trace: recipient `ops@<domain>` (the trace records the resolved address, not the `+` alias), date range including today, delivery status **Delivered**. New tenants can take a few hours to show messages. Reading the mailbox itself needs a persona sign-in, which runs into the MFA prompt (deferred to Phase 6).
- **Deferred to Phase 6 (needs persona sign-in, so the MFA decision first):** add `ops@<domain>` as a Cloudflare destination (its verification email lands in the shared mailbox), point the catch-all and literal rules at it, and tighten DMARC to `p=quarantine`. Until then routing forwards to the operator mailbox and DMARC stays `p=none`.
- **Deferred:** Passbolt SMTP (no spare licensed mailbox for SMTP AUTH, and basic SMTP AUTH is being retired; see DESIGN.md §10 SMTP relay) and the persona MFA policy (Phase 6).
- Set a renewal reminder (sandbox expires every 90 days unless there is qualifying activity; the app secret also expires).
- **Record:** tenant ID, tenant name, sandbox expiry, `ve-provisioning` secret expiry, persona roster version.

### Users: provision from the roster; remove sample users

Entra ID **cannot export existing passwords**, so pre-provisioned sample users (instant sandbox) can't be "imported" into the vault without resetting them. They are also generic sample personas, not the canonical employees, and each holds an E5 license the personas need. `cleanup.mjs` removes them. Then:

1. The persona roster comes from `canonical/org/personas.yaml` (25 personas: name, title, department, site, manager, groups; UPN `{first}.{last}@<domain>`), and groups from `canonical/org/groups.yaml` (DESIGN.md §2.1).
2. `scripts/m365/provision.mjs` creates the catalog groups (security groups), then for each persona:
   - generates a strong random password and stores it in the vault's `Personas` folder (resource name = UPN) **before** creating the user, so a crash never leaves an unknown password;
   - creates the user via Microsoft Graph (`forceChangePasswordNextSignIn = false`) with title, department, site, usage location, employee ID, and hire date;
   - adds group memberships and the manager. Licensing is group-based: the E5 license is assigned to `app-m365`, whose members are the 25 licensed personas. The rest of the employees stay unlicensed identities.
3. **MFA:** new tenants enable security defaults, which force MFA registration on first interactive sign-in. Phase 6a replaces them with Conditional Access and registers each persona's vault TOTP seed as a hardware OATH token (see Phase 6).
4. The script is idempotent: it plans from live state, fixes attribute drift, adds missing memberships (`--prune` also removes stale ones), and resets and re-vaults a password only with `--rotate <upn|all>`.

## Phase 5: Infrastructure

5a and 5b are independent; do them in either order. Secrets for both sites sync between gitignored `.env` files and the vault with `scripts/env/secret-env.mjs` (generated once, vault first, restored from the vault on a fresh clone).

### 5a. Cloud site (OCI Always Free)

**Agent-assisted:** run the `/setup-cloud-site` skill; it drives Terraform (plan, then apply on your yes), bootstraps the VM, and connects the tunnel through the `cloudflare` MCP.

- [ ] **[manual]** Create an OCI account with `oci-admin@svc.<domain>` (card verification). Choose the home region deliberately: it's permanent, and Always Free A1 capacity exists only there. Store root credentials in `Break-glass`; enable MFA.
- [ ] **[manual]** Upgrade to Pay-As-You-Go: Always Free stays $0, but free-tier accounts lose idle instances, and PAYG gets A1 capacity more easily.
- [ ] **[manual]** Generate an API signing key (Profile → My profile → API keys) and save it to `~/.config/virtual-enterprise/oci_api_key.pem`. **[script]** Create the VM SSH key `~/.config/virtual-enterprise/cloud_ssh`; vault copies of both.
- [ ] **[script]** Write `infra/oci/terraform.tfvars` (from `.example`; no secrets), then `terraform plan` / `apply` in `infra/oci/`: compartment, **$1 budget alert** to the operator mailbox, VCN + subnet with **no inbound** except optional SSH from `admin_cidrs` (your IP while setting up), one A1 VM (Ubuntu 24.04 arm64, 4 OCPU / 24 GB, 100 GB boot). The Autonomous DB is off until Phase 10 (`create_autonomous_db`). On "Out of host capacity", try another `availability_domain_index` or retry later.
- [ ] **[script]** cloud-init installs Docker + Compose and unattended upgrades; wait for `cloud-init status --wait`.
- [ ] **[manual]** Create tunnel `cloud` in Zero Trust → Networks → Tunnels, and paste its token into `infra/compose/cloud/.env` (the token never goes through the agent). **[script]** Vault it, copy `infra/compose/cloud/` to `/opt/ve/cloud` on the VM, `docker compose up -d`, and prove it end to end with a temporary `hello-cloud.<domain>` → `hello_world` route.
- Services join `infra/compose/cloud/` in later phases (authentik: Phase 6, Odoo: Phase 7) and get public hostnames on this tunnel (plus `vault.` if the vault moves here; see Phase 2). Put admin UIs behind Cloudflare Access (Zero Trust free tier) when they're added.
- **Record:** OCI tenancy OCID and region, VM name and IP, tunnel ID. Keep a copy of `infra/oci/terraform.tfstate` with the vault backups.

### 5b. On-prem site (x86 Docker host)

**Agent-assisted:** run the `/setup-onprem-site` skill; it deploys the stack on this machine or a remote host over SSH, smoke-tests it end to end, and applies the Splunk license.

Stack: `infra/compose/onprem/` (SQL Server 2022 Developer, Splunk Enterprise, optional `cloudflared`).

- [ ] **[manual]** Choose the x86_64 host: **this machine** (quick start; Docker Desktop with ~12 GB+ memory; only up while the machine is) or a **dedicated host/VM** on a private network with no inbound from the internet (~4 vCPU, 16 GB RAM, 100+ GB disk, Docker + Compose, SSH from this machine; e.g. a VM on Visual Studio subscription Azure credits with auto-shutdown, or a Hyper-V/physical box).
- [ ] **[script]** Write `infra/compose/onprem/.env`: `BIND_ADDR` (`127.0.0.1` if the SUT gateway runs on the same host, otherwise the host's LAN IP); `MSSQL_SA_PASSWORD`, `SUT_READER_PASSWORD`, `SPLUNK_PASSWORD`, and `SPLUNK_HEC_TOKEN` (GUID) via `secret-env.mjs` into `Service & API`.
- [ ] **[script]** `docker compose up -d` (remote host: copy the folder to `~/ve/onprem` first). `sqlserver-init` creates the `Operations` DB and the read-only `sut_reader` login; Splunk loads the `ve_indexes` app (`idp`, `app`, `network`, `cloudflare`, `onprem`, `sut_audit`).
- [ ] **[script]** Smoke tests (through `docker compose exec` and `curl`, so no host tools needed): `sut_reader` reads `Operations` and **can't** create a table; Splunk REST on `:8089` answers; an event posted to HEC (`:8088`, index `onprem`) comes back from a search.
- [ ] **[manual]** Request a Splunk Enterprise developer license with `splunk-admin@svc.<domain>` and save it to `~/.config/virtual-enterprise/splunk-dev.lic`. **[script]** Apply it (`splunk add licenses`, restart). Until then Splunk runs a 60-day trial and then drops to Free (no authentication). Set a renewal reminder.
- [ ] *(Optional, direct access)* Create tunnel `onprem` (token into `infra/compose/onprem/.env`), `docker compose --profile tunnel up -d`, and map `siem.` → `http://splunk:8000`, `siem-api.` → `https://splunk:8089` (noTLSVerify), `hec.` → `https://splunk:8088` (noTLSVerify). Protect `siem.` with Cloudflare Access. SQL Server is not published (raw TCP needs client-side `cloudflared`).
- **Sign in:** Splunk web UI at `http://<BIND_ADDR>:8000` (host only when `BIND_ADDR=127.0.0.1`), user `admin`, password from Passbolt `Service & API` → `On-prem Splunk: admin` (also `SPLUNK_PASSWORD` in `.env`). REST `:8089` uses the same account; HEC `:8088` uses the token in `On-prem Splunk: HEC token`. SQL Server `<BIND_ADDR>,1433`: `sa` for administration (`On-prem SQL Server: sa`), `sut_reader` (read-only) for the SUT. Check with the search `index=onprem sourcetype=ve:smoke`.
- **Record:** host and network, `BIND_ADDR`, SQL Server and Splunk versions, license expiry, tunnel ID (if used).

## Phase 6: Workforce Identity

**MFA policy (decided):** MFA is enforced for every persona in every IdP. Each persona has one TOTP seed in the vault (`Personas` / `TOTP: <upn>`, base32, SHA1, 30 s, 6 digits), shared by Entra, authentik, and Okta and registered by script, so sign-ins are MFA-protected yet automatable (`node scripts/lib/totp.mjs code <upn>`). Do 6a first; it creates the seeds. 6b and 6c follow in either order.

### 6a. Entra MFA (and Phase 4's deferred items)

**Agent-assisted:** run the `/setup-entra-mfa` skill.

- [ ] **[manual]** Add Graph application permissions to `ve-provisioning` and grant admin consent: `Policy.ReadWrite.AuthenticationMethod`, `UserAuthenticationMethod.ReadWrite.All`, `Policy.ReadWrite.ConditionalAccess`, `Policy.Read.All`, `Application.Read.All`.
- [ ] **[manual]** Confirm the Global Administrator (break-glass) has its own MFA method; it's excluded from Conditional Access but Microsoft enforces MFA on admin portals.
- [ ] **[script]** `node scripts/m365/mfa.mjs` (plan), then `--apply`: enable the Hardware OATH method; per persona, create the vault seed and a hardware OATH token (serial `VE-<employee ID>`) carrying it, assigned and activated (Graph beta, preview API); create `VE - Require MFA for all users` and `VE - Block legacy authentication` (Global Administrators excluded); turn off security defaults and enable the policies once every token is active. Method propagation can take up to an hour; re-run until no changes.
- [ ] **[manual]** Verify: sign in at `https://myapps.microsoft.com` as `it-director` with password + code.
- [ ] Deferred from Phase 4: as `it-director`, open the `ops@<domain>` shared mailbox; **[script]** add `ops@<domain>` as a Cloudflare Email Routing destination (**[manual]** click its verification email), repoint the catch-all and literal `svc.` rules at it, and record **Email routing destination** = `ops@<domain>`; tighten DMARC to `p=quarantine`.

### 6b. authentik (primary IdP, cloud site)

**Agent-assisted:** run the `/setup-authentik` skill.

- [ ] **[script]** Secrets into `infra/compose/cloud/.env` via `secret-env.mjs` (`AUTHENTIK_SECRET_KEY`, `AUTHENTIK_PG_PASS`, `AUTHENTIK_BOOTSTRAP_PASSWORD`, `AUTHENTIK_BOOTSTRAP_TOKEN`); `AUTHENTIK_BOOTSTRAP_EMAIL=sso-admin@svc.<domain>`.
- [ ] **[script]** Copy the stack to `/opt/ve/cloud` on the VM and `docker compose up -d` (authentik 2025.10: server, worker, PostgreSQL; no Redis). Publish `sso.<domain>` → `http://authentik-server:9000` on tunnel `cloud`.
- [ ] **[manual]** Sign in as `akadmin`, enroll its TOTP, copy its credentials to `Break-glass`.
- [ ] **[script]** `node scripts/authentik/provision.mjs` (plan), then `--apply`: catalog groups, 25 personas with attributes and memberships, passwords (vault `authentik: <upn>`), TOTP devices from the seeds (via `ak shell` over SSH; authentik's API can't set a TOTP key).
- [ ] **[manual]** Verify a persona sign-in at `https://sso.<domain>` with password + code.
- Outbound email (recovery, notifications) waits on the SMTP relay decision (DESIGN.md §10).

### 6c. Okta (secondary IdP)

**Agent-assisted:** run the `/setup-okta` skill.

- [ ] **[manual]** Sign up for the Okta Integrator Free Plan with `okta-admin@svc.<domain>` (business email; **10 active users** max). Store admin credentials in `Break-glass`.
- [ ] **[manual]** Create API token `ve-provisioning` into Passbolt `Service & API` / `Okta API token`; add the **Custom OTP** authenticator (SHA1, 6 digits, 30 s) and record its factor profile ID; require Password + Another factor in the authentication policies.
- [ ] **[script]** `node scripts/okta/provision.mjs` (plan), then `--apply`: catalog groups, the 10-persona subset (`idp_subsets.okta` in `personas.yaml`), passwords (vault `okta: <upn>`), Custom OTP enrolled with each persona's seed.
- [ ] **[manual]** Verify a persona sign-in with password + code.

- **Record:** Entra MFA state, authentik URL and version, Okta org URL, Okta custom OTP factor profile.

## Phase 7: HR (Odoo Community + Payroll DB)

- [ ] **[script]** Deploy Odoo Community + Postgres via Compose at `https://hr.<domain>` (verify arm64 image).
- [ ] **[manual]** Create database, install apps: Employees, Time Off, Recruitment, Attendance, Expenses (Inventory/Purchase optional).
- [ ] **[script]** Create the `payroll` schema in Postgres.
- [ ] **[script]** Create an API user for loaders and SUT access; store it in `Service & API`.
- **Record:** Odoo URL, DB name.

## Phase 8: SIEM Ingestion

Splunk is deployed in Phase 5b.

- [ ] **[script]** Forward logs to Splunk HEC: Cloudflare audit logs (`cloudflare`), OCI audit + cloud-site app logs (`app`), IdP sign-ins (`idp`), on-prem host/Docker logs (`onprem`).
- **Record:** HEC sources.

## Phase 9: SaaS Accounts

Sign up each with `<system>-admin@svc.<domain>`; store the login in `Vendor admins` and API credentials in `Service & API`.

- [ ] **[manual]** Salesforce Developer Edition
- [ ] **[manual]** HubSpot developer test account
- [ ] **[manual]** QuickBooks Online sandbox (Intuit Developer) *(or ERPNext)*
- [ ] **[manual]** Shopify Partner account + dev store; create a Storefront API access token (headless channel) and Admin API app
- [ ] **[manual]** Stripe account (test mode)
- [ ] **[manual]** ServiceNow Personal Developer Instance
- [ ] **[manual]** Jira Cloud (free) + GitHub organization
- [ ] **[manual]** Snowflake trial
- [ ] **[manual]** Google account (`ga-admin@svc.<domain>`) → GA4 property + web data stream for `www.<domain>`; create a Measurement Protocol API secret
- [ ] **[manual]** Supabase account/org + project (region near the OCI home region)
- [ ] **[manual]** Cloudflare Workers (free plan) on the Phase 1 account; create an API token for `wrangler` (Workers Scripts:Edit, Workers Routes:Edit) and store it in `Service & API`
- [ ] Note expirations (PDI hibernation, Snowflake trial end, Supabase inactivity pause).
- **Record:** instance URLs, org/project IDs, GA4 measurement ID, expiry dates.

## Phase 10: Canonical Data & Loaders

- [ ] **[script]** Run the canonical generator (fixed seed): customers, contacts, products, employees, price lists, cross-system ID map.
- [ ] **[script]** Load employees into Odoo, then provision them to authentik, Okta, and Entra; vault any new persona credentials.
- [ ] **[script]** Run loaders per system (Salesforce, HubSpot, QBO, Shopify catalog + customers, Stripe, ServiceNow, Jira, SharePoint, Postgres, Autonomous DB, Snowflake).
- [ ] **[script]** Load the on-prem `Operations` DB (SQL Server): production orders, BOMs, warehouse bins/inventory, shipments (referencing Shopify order IDs), plus large scale-test tables. Loader runs on the on-prem host or over the private network.
- [ ] **[script]** Seed storefront customers: create Supabase Auth users for canonical contacts; vault their credentials in `Customers`; link Supabase user ↔ Shopify customer ↔ CRM account.
- [ ] **[script]** Inject intentional data-quality issues per DESIGN.md §4.
- [ ] Validate record counts per system against the canonical dataset.
- **Record:** seed value, generator version, load date.

## Phase 11: Storefront Web App

Design: [apps/storefront/DESIGN.md](apps/storefront/DESIGN.md).

- [ ] **[script]** Apply Supabase migrations (`apps/storefront/supabase/migrations/`): customers, orders mirror, support requests, webhook events, RLS policies.
- [ ] **[script]** Configure Supabase Auth: site URL `https://www.<domain>`, redirect URLs, SMTP via M365 `ops@<domain>` (or Supabase default for testing).
- [ ] **[script]** Deploy Edge Functions `link-customer` and `shopify-webhook`; set their secrets from the vault (`supabase secrets set`: Shopify Admin token, Shopify webhook secret, GA4 API secret).
- [ ] **[script]** Build the static export with public values from the vault (`NEXT_PUBLIC_*`: Shopify store domain + Storefront public token, Supabase URL + publishable key, GA4 measurement ID); `wrangler deploy` to Cloudflare Workers static assets.
- [ ] **[script]** Attach `www.<domain>` as a Workers custom domain; add an apex → `www` redirect rule.
- [ ] **[script]** Register Shopify webhooks (`orders/create`, `orders/updated`, `orders/fulfilled`, `refunds/create`) → `shopify-webhook` Edge Function URL.
- [ ] Smoke test: sign up → browse → add to cart → checkout (Bogus Gateway) → order appears in Shopify, Supabase mirror, and GA4 realtime.
- **Record:** Worker name, Edge Function URLs, webhook IDs.

## Phase 12: SUT Integration

Per SUT (see DESIGN.md §7):

- [ ] **[manual]** Create/choose the SUT account/tenant for this environment.
- [ ] **[manual]** Register the SUT as an SSO app in authentik (SAML + OIDC), Okta, and Entra.
- [ ] **[manual]** Configure SCIM provisioning from each IdP into the SUT; map groups to SUT roles.
- [ ] **[manual]** Install the SUT's on-prem gateway/agent (if any) in the on-prem site, outbound-only; point it at SQL Server (`sut_reader`) and Splunk (`:8089`).
- [ ] **[script]** Create SUT connections/credentials to environment systems per persona (read-only vs read-write).
- [ ] **[script]** Forward SUT audit logs to the SIEM.
- [ ] **[script]** Implement/configure the eval adapter in `evals/adapters/<sut>/`.
- **Record:** SUT tenant, SSO/SCIM app IDs, connection names.

## Phase 13: Simulator & Evals

- [ ] **[script]** Schedule the daily simulator run (business processes in DESIGN.md §5), including synthetic storefront sessions.
- [ ] **[script]** Start log emitters (IdP, app, network) pointed at the SIEM.
- [ ] **[script]** Generate the eval question bank with expected answers from canonical data.
- [ ] **[script]** Run the eval runner against the SUT and store the baseline score.

## Phase 14: Ongoing Maintenance

- [ ] Monthly: review renewal dates in `local/registry.md` (domain, M365 90-day, Splunk license, Snowflake trial, ServiceNow PDI, Supabase pause, OCI reclamation status).
- [ ] Rotate API tokens and persona/customer passwords (provisioning scripts `--rotate`).
- [ ] Run the vault `backup.sh`; periodically test `restore.sh` into a throwaway stack.
- [ ] Re-run the eval suite on each SUT release.

---

## Registry Template

Copy to `local/registry.md` (gitignored). Non-secret values only; secrets live in the vault.

| Key | Value | Renewal / Expiry |
|---|---|---|
| Company name | | |
| Domain | | Annual |
| Operator mailbox | | |
| Cloudflare account ID | | |
| Cloudflare zone ID | | |
| Email routing destination | | |
| Email Routing mode | | |
| Email Routing apex | | |
| Vault URL | `https://vault.<domain>` | |
| Vault host | | |
| Vault bind address | | |
| Vault backup location | | |
| Vault automation user | `automation@svc.<domain>` | |
| M365 tenant ID | | 90-day |
| M365 tenant name | | |
| M365 developer program account | | |
| ve-provisioning secret | | |
| Persona roster version | | |
| OCI tenancy / region | | |
| OCI VMs | | Idle reclamation |
| Cloud VM address | | |
| Autonomous DB | | |
| Cloudflare Tunnel IDs (cloud / onprem) | | |
| On-prem host / network | | |
| On-prem `BIND_ADDR` | | |
| SQL Server version | | |
| Splunk version | | Dev license |
| Splunk URL (if tunneled) | `https://siem.<domain>` | |
| SUT gateway host | | |
| Entra MFA | | |
| authentik URL | `https://sso.<domain>` | |
| authentik version | | |
| Okta org URL | | API token expires after 30 days unused |
| Okta custom OTP factor profile | | |
| Odoo URL | `https://hr.<domain>` | |
| Salesforce org | | |
| HubSpot account | | |
| QBO sandbox company | | |
| Shopify dev store | | |
| Stripe account | | |
| ServiceNow PDI | | Hibernation |
| Jira site | | |
| Snowflake account | | Trial |
| GA4 property / measurement ID | | |
| Supabase project | | Inactivity pause |
| Storefront Worker | | |
| Storefront URL | `https://www.<domain>` | |
| Canonical seed | | |
