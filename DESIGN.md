# Virtual Enterprise

A fictional company whose business systems, processes, and data form a realistic, repeatable environment for testing SaaS software: integration and data platforms, AI agents, identity/SSO/SCIM, security tooling, or anything else that needs a "real" enterprise to connect to.

Status: **Design** (started 2026-09-23)

**Terminology**

| Term | Meaning |
|---|---|
| **Operator** | The organization or person deploying an instance of this environment. |
| **SUT** | *System under test*: the product being tested against the environment. |
| `<company>` / `<domain>` | The fictional company's name and domain, chosen per deployment. |
| **Cloud site** | Self-hosted apps published to the internet (via Cloudflare Tunnel). |
| **On-prem site** | The company's "HQ datacenter": private network, no inbound access. |

---

## 1. Goals

- Test a SUT against a realistic multi-system enterprise, not isolated single-app test accounts.
- Provide **ground-truth answers** so SUT results (queries, AI answers, sync output) can be scored, not eyeballed.
- Be **rebuildable** from scratch deterministically, and eventually fully automated.
- Prefer **free / open source / developer-tier** systems wherever possible.
- **SUT-agnostic and operator-agnostic:** publishable as a public repo; no operator- or SUT-specific values committed.
- Keep all test data and identities **isolated from the operator's production tenants**.

## 2. The Company

A fictional B2B industrial distributor / light manufacturer. Each deployment chooses its own name and domain (see [SETUP.md](SETUP.md) Phase 1).

| Attribute | Value |
|---|---|
| Employees | ~400 |
| Regions | 3 (NA, EMEA, APAC) |
| Customers | ~2,000 accounts |
| Products | ~5,000 SKUs |
| Departments | Sales, Marketing, Finance, Operations, Support, Engineering, HR, IT/Security |
| Web presence | Public landing page + customer portal (login, catalog, ordering) |
| On-prem | HQ datacenter running legacy manufacturing/warehouse DB and SIEM |

Chosen because the business naturally spans CRM, ERP, commerce, support, HR, identity, security, and a hybrid cloud/on-prem footprint.

### 2.1 Organization

Defined as data in `canonical/org/`; every system's users and groups derive from it.

| File | Defines |
|---|---|
| `sites.yaml` | Regions (NA 60%, EMEA 25%, APAC 15%) and sites: Columbus HQ + plant + on-prem datacenter (USD), Rotterdam distribution center (EUR), Singapore sales & sourcing (SGD) |
| `departments.yaml` | 9 departments with description, head, cost center, headcount per region (400 total), and default apps |
| `groups.yaml` | Group catalog and naming: `dept-*`, `region-*`, `role-*` (permission tests), `app-*` (access); provisioned to every IdP, with `dept-*`/`region-*`/`role-*` pushed to the SUT |
| `personas.yaml` | 25 named employees with manager, groups, lifecycle events, and a **test purpose** each |

- **Personas vs generated employees:** the 25 personas are the M365 E5 sandbox's 25 licensed users (`app-m365`, group-based licensing) and the people tests refer to by name. The other ~375 employees are generated with a fixed seed, report into persona managers, and exist as unlicensed identities in Odoo and the IdPs.
- **Designed-in test cases:**
  - `app-sut` holds 17 of 25 personas, so SCIM scoping has negative cases.
  - `role-payroll` excludes the CEO and CFO: seniority doesn't imply data access.
  - A mover (`ae-apac`, APAC → EMEA) and a leaver (`support-t1`) have lifecycle events scheduled relative to the seed date.
  - A joiner (a generated employee with a future start date) gets a license on the start date.
- **IDs:** personas are `E0001`–`E0025`; generated employees start at `E0026`. UPNs are `{first}.{last}@{domain}`.
- **Admin accounts** (tenant global admin, IdP admins) are break-glass accounts, not personas.

## 3. System Stack

| Function | System | Site | Tier / Cost | Notes |
|---|---|---|---|---|
| Edge / DNS / Zero Trust | **Cloudflare** (Registrar, DNS, Email Routing, Tunnel, Access) | SaaS | Free tier (at-cost domain) | Tunnel publishes self-hosted apps without inbound ports; audit logs → SIEM. |
| Web hosting | **Cloudflare Workers static assets** | SaaS | Free | Static Next.js export; no server compute. |
| Collaboration / files | **Microsoft 365 Developer Program E5 sandbox** | SaaS | Free (requires VS subscription or partner eligibility), 90-day renewable | SharePoint, OneDrive, Teams, Outlook, Excel. |
| HR | **Odoo Community** | Cloud | Open source (LGPL) | Employees, departments, time off, recruitment, attendance, expenses. Payroll is Enterprise-only → see below. |
| Payroll / comp | **PostgreSQL** (`payroll` schema) | Cloud | Open source | Sensitive dataset for permission tests. |
| Workforce identity (primary) | **authentik** | Cloud | Open source | SAML + OIDC SSO; built-in outbound SCIM provider. |
| Workforce identity (secondary) | **Okta Developer org** | SaaS | Free | Commercial SCIM/SSO reference implementation. |
| Workforce identity (tertiary) | **Entra ID** (M365 dev tenant) | SaaS | Included with E5 sandbox | E5 includes Entra ID P1/P2 → SCIM to custom apps. |
| Customer identity | **Supabase Auth** | SaaS | Free tier | Storefront customer accounts, distinct from workforce identity. |
| Operator vault | **Passbolt Community Edition** | Operator machine → any Docker host | Open source (AGPL) | All environment credentials. See §3.4. |
| Manufacturing / warehouse (MES/WMS) | **SQL Server 2022 Developer** (`Operations` DB) | **On-prem** | Free (Developer edition) | Legacy system: production orders, BOMs, bin inventory, shipments. Also hosts large-table scale tests. Reachable only via a SUT gateway/agent or Tunnel. |
| SIEM | **Splunk Enterprise** (dev license) | **On-prem** | Free dev license (~10 GB/day) | x86 only. |
| CRM | **Salesforce Developer Edition** | SaaS | Free | Primary CRM. |
| CRM / Marketing | **HubSpot** developer test account | SaaS | Free | Intentional CRM overlap (realistic source ambiguity). |
| ERP / Finance | **QuickBooks Online sandbox** (or ERPNext) | SaaS | Free | Invoices, payments, GL. |
| Commerce | **Shopify Partner dev store** | SaaS | Free | Catalog, cart, checkout, orders (headless via Storefront API). |
| Web storefront | **Next.js** (static export) + **Supabase** (Postgres, Auth, Edge Functions) | SaaS | Free | Landing page + customer portal. See §3.1. |
| Web analytics | **Google Analytics 4** | SaaS | Free | Storefront traffic and ecommerce events. |
| Payments | **Stripe** test mode | SaaS | Free | Payments, refunds, subscriptions. |
| Support / ITSM | **ServiceNow PDI** | SaaS | Free | Customer + internal IT tickets. |
| Engineering / PM | **Jira** (free tier), **GitHub** | SaaS | Free | Issues, escalations. |
| Data platform | **PostgreSQL**, **Oracle Autonomous DB** (OCI), **Snowflake** trial | Cloud / SaaS | Free / trial | Warehouse + operational DBs. |

**Fallback rule:** if the SUT lacks an API connector for a self-hosted open source app, reach it through its backing database (Postgres/MySQL).

### 3.1 Storefront Web Application

Full design: [apps/storefront/DESIGN.md](apps/storefront/DESIGN.md).

```
Browser ──> static Next.js (Cloudflare, free) ─┬─> Shopify Storefront API (public token)   catalog, cart, hosted checkout
                                               ├─> Supabase Auth + Postgres (RLS)         customer login, portal data
                                               └─> GA4 gtag                               page views + ecommerce events
Shopify webhooks ──> Supabase Edge Function ──> orders mirror + GA4 Measurement Protocol
```

- **Systems of record:** Shopify owns catalog, checkout, and orders. Supabase owns customer login and portal data. Every Supabase user maps to a canonical customer contact → Shopify customer → CRM account.
- **Data sources gained:** Supabase Postgres, GA4, a web-originated Shopify order stream, and customer identity (CIAM) separate from workforce identity.

### 3.2 Hosting: Two Sites

| | Cloud site | On-prem site ("HQ datacenter") |
|---|---|---|
| Purpose | Self-hosted apps a real company would expose to the internet | Legacy/internal systems behind the corporate firewall |
| Services | authentik, Odoo, Postgres | SQL Server, Splunk Enterprise |
| Host | OCI Always Free Ampere A1 (arm64; 4 OCPU / 24 GB total; verify current limits) | Any x86_64 Docker host on a private network, e.g. a VM with no public IP (VS subscription Azure credits) or a physical/Hyper-V box |
| Provisioning | Terraform (`infra/oci/`) + Compose (`infra/compose/cloud/`) | Compose (`infra/compose/onprem/`) |
| Inbound | None; published via Cloudflare Tunnel | None |
| SUT access | Public HTTPS hostnames | **SUT on-prem gateway/agent** (outbound-only) is the primary path; Cloudflare Tunnel optional for direct access |

**Cloud site constraints (OCI):**

- **arm64:** every image must support `linux/arm64` (authentik, PostgreSQL, `cloudflared` are multi-arch; verify Odoo and Passbolt if the vault moves here).
- **Idle reclamation:** Always Free instances idle for 7 days may be reclaimed. Upgrading the account to Pay-As-You-Go (still $0 within Always Free limits) is reported to avoid this; set a budget alert at $1.
- **Capacity:** A1 capacity can be scarce in popular regions; the home region is permanent.

**On-prem site notes:**

- **x86 only:** SQL Server and Splunk Enterprise do not support arm64 (Splunk documents ARM as unsupported for Enterprise; only the Universal Forwarder runs on aarch64).
- **Sizing:** ~16 GB RAM, 4 vCPU, 100+ GB disk (Splunk ~8–12 GB, SQL Server ~2–4 GB).
- **Ports** bind to `127.0.0.1` by default (gateway on the same host) or a LAN address (gateway on another on-prem machine), set via `BIND_ADDR`.
- **Direct access via Tunnel:** works for HTTP(S) services (Splunk web, REST API on 8089, HEC). Raw TCP (SQL Server on 1433) through Tunnel requires `cloudflared`/WARP on the *client* side, so cloud SUTs normally reach SQL Server through their gateway.
- **Future option:** Windows Server host with on-prem Active Directory synced to Entra (hybrid identity).

### 3.3 Domain & Email

A real domain owned by the operator is required: IdP federation and SSO routing key off a verified email domain, vendor sign-ups require verifiable email, and apps need public HTTPS hostnames. Reserved TLDs (`.example`, `.test`) cannot be used.

| Namespace | Routing | Purpose |
|---|---|---|
| `<domain>` | Mail: Exchange Online (M365 E5 sandbox) | Employee identities (SSO/SCIM login names) |
| `svc.<domain>` | Mail: Cloudflare Email Routing catch-all → operator mailbox, later shared M365 mailbox | SaaS sign-ups, vendor admin accounts, simulated-user verification |
| `www.<domain>` | Web: Cloudflare Workers static assets | Storefront |
| `sso.` / `hr.` `<domain>` | Web: Cloudflare Tunnel → cloud site | Self-hosted apps |
| `vault.<domain>` | Hosts file → operator machine initially; later Cloudflare Tunnel + Access | Operator vault (Passbolt). Permanent URL. |
| `siem.` / `siem-api.` / `hec.` `<domain>` | Web: Cloudflare Tunnel → on-prem site (optional) | Direct access to Splunk |

- M365 E5 sandbox provides **25 licensed mailboxes** for key personas. The other ~375 employees exist in the IdPs without mailboxes.
- Use plus-addressing (`it-admin+okta@<domain>`) or the `svc.` catch-all for additional addresses.

### 3.4 Credentials

- **Operator vault:** self-hosted **Passbolt Community Edition** (`infra/compose/vault/`), running from Phase 2, the first step after the domain exists. End-to-end encrypted (OpenPGP), team sharing, folders, TOTP MFA, API + `go-passbolt-cli`.
- **Permanent URL:** `https://vault.<domain>` from day one. It starts on the operator's machine (hosts-file entry; Traefik in front with a Let's Encrypt certificate obtained via Cloudflare DNS-01, so it's publicly trusted without a public DNS record) and moves to another host by backup/restore without changing the URL, so no user re-enrolls. If published, it sits behind Cloudflare Tunnel + Cloudflare Access.
- **Break-glass:** the admin recovery kit + passphrase, server GPG keys, and DB backups are stored **outside Passbolt** (offline / personal password manager). Credentials created before the vault exists (Cloudflare) live in the operator's personal password manager until Phase 2.
- **Automation:** a dedicated Passbolt user (`automation@svc.<domain>`) that creates the working folders and makes the admin an Owner; it never has access to `Break-glass`. Its private key and passphrase live in `~/.config/virtual-enterprise/` (outside the repo, user-only permissions) so agents and scripts can run unattended; that exposure is bounded by its folder access. Scripts reach credentials only through the **vault adapter** (`scripts/vault/vault.mjs`, Node so it runs on every platform), which wraps `go-passbolt-cli` with idempotent `ensure-folder` / `upsert` / `get`, so the provider can change without touching callers. Compose `.env` files are written with `scripts/env/set-env.mjs` and gitignored.
- **CE limits:** no SSO, LDAP sync, or admin-assisted account recovery (Pro features). Not depending on the environment's own IdPs is deliberate for the vault that holds their admin credentials. Recovery is email-based, so SMTP is configured in Phase 4.
- **Scope:** the operator vault is not a system in the fictional company. It is never exposed to the SUT.

## 4. Architecture

```
canonical/            master dataset: single source of truth
  org/                sites, departments, groups, 25 personas (hand-authored YAML; §2.1)
  generator/          seeded, deterministic entity generation
  schema/             master entities + cross-system ID map
loaders/              one per target system; push canonical data via vendor APIs
simulator/            daily "business day" engine
  processes/          end-to-end business flows (see §5)
  web/                synthetic storefront sessions (headless browser)
  logs/               security/application event emitters -> SIEM
apps/
  storefront/         static Next.js site + its Supabase project (migrations, edge functions); own DESIGN.md
evals/
  questions.yaml      question + expected answer (computed from canonical data)
  runner/             SUT-agnostic runner; scores results
  adapters/           one adapter per SUT (not committed for private SUTs)
personas/             user roles with distinct permissions
infra/
  oci/                Terraform for cloud-site VMs, networking, Autonomous DB
  compose/
    cloud/            cloud-site stack (authentik, Odoo, Postgres, ...)
    onprem/           on-prem stack (SQL Server, Splunk, optional cloudflared)
    vault/            operator vault (Passbolt CE + MariaDB, backup/restore scripts)
scripts/              provisioning scripts, vault adapter
  prereqs/            operator-machine prerequisite check/install (prereqs.ps1, prereqs.sh)
  vault/              vault adapter (vault.mjs) over go-passbolt-cli
  env/                idempotent .env writer (set-env.mjs)
  lib/                registry.mjs (local/registry.md get/set), org.mjs (org model loader)
  m365/               Graph client, domain.mjs, cleanup.mjs, provision.mjs (org model → M365 sandbox)
local/                gitignored: registry, operator notes
.mcp.json             project MCP servers for agent-assisted setup (no secrets)
.claude/skills/       agent skills that run SETUP.md phases (e.g. setup-prerequisites)
```

### Design principles

1. **Cross-system keys:** every record carries references to its counterparts (e.g. Shopify order metadata holds the CRM Account ID; the on-prem shipment references the Shopify order; Supabase user maps to canonical contact). Needed for questions that join data across systems.
2. **Deterministic seed:** the full company can be rebuilt identically so expected answers stay stable.
3. **Intentional data quality issues:** ~5% duplicates, name variants ("Acme Corp" / "ACME Corporation"), stale records, currency and timezone mismatches.
4. **Time progression:** the simulator generates daily activity, enabling "what changed" / trend questions.
5. **Isolation:** all tenants and accounts are dedicated test instances owned by the operator (not personal), never production tenants.
6. **Nothing deployment-specific in git:** names, IDs, URLs, and secrets live in `local/`, `.env` files, and the vault. Committed docs and code use placeholders.

## 5. Business Processes (Simulator)

| Process | Systems touched |
|---|---|
| Lead → Opportunity → Quote → Order → Invoice → Payment | HubSpot, Salesforce, Shopify, QBO, Stripe |
| Web visit → Sign-up → Browse → Order | Storefront, Supabase Auth, Shopify, GA4 |
| Order → Production → Pick/Pack → Shipment | Shopify, **SQL Server (MES/WMS, on-prem)** |
| Shipment → Support ticket → Refund | SQL Server, ServiceNow, Stripe, storefront portal |
| Escalation → Engineering issue | ServiceNow, Jira, GitHub |
| **Joiner / Mover / Leaver** | Odoo HR → authentik / Okta / Entra → SCIM → SUT, M365 |
| Security telemetry | IdP sign-ins, Cloudflare, OCI audit, app logs, on-prem host logs, synthetic firewall/VPN, **SUT audit logs** → Splunk |

## 6. Test Categories

Examples phrased for a data/AI SUT; adapt per SUT.

| Category | Example |
|---|---|
| Single-source read | "Top 10 open opportunities by amount in EMEA" |
| Cross-source join | "Customers with >$50k ARR and 3+ open P1 tickets" |
| Reconciliation | "Orders shipped in Shopify but not invoiced in QBO" |
| **Hybrid (cloud + on-prem)** | "Shopify orders paid but not yet shipped from the warehouse" |
| **On-prem connectivity** | SUT reaches SQL Server/Splunk through its gateway; gateway down/restart/latency behavior |
| Web / funnel | "Conversion rate from GA4 sessions to Shopify orders last week" |
| Write-back | Create a Jira issue from a ServiceNow escalation; update opportunity stage |
| Procedures / actions | Source-specific actions (e.g. SharePoint file upload) |
| Permissions | Sales persona cannot see payroll data; SQL login is read-only |
| SSO | Log in to the SUT via authentik, Okta, Entra (SAML and OIDC) |
| SCIM | Provision, update, group change, deprovision users into the SUT |
| Security / SIEM | "Users deprovisioned in authentik who were active in the SUT last week" (Splunk) |
| Ambiguity | "Revenue last quarter": CRM bookings vs ERP recognized revenue |
| Scale / performance | 500k+-row tables in SQL Server; paging through API-rate-limited sources |

## 7. Integrating a SUT

A SUT plugs in without changes to the core environment:

1. **Identity:** SSO app + SCIM target registered in each IdP.
2. **Access:** per-persona credentials/connections to the systems the SUT needs (read-only and read-write personas).
3. **On-prem:** the SUT's gateway/agent (if it has one) installed in the on-prem site, connecting outbound only.
4. **Audit:** SUT audit logs forwarded to the SIEM.
5. **Evals:** an adapter in `evals/adapters/<sut>/` that submits questions/actions to the SUT and returns results for scoring.

## 8. Phasing

1. **Foundation:** domain, email, operator vault, M365; canonical generator; cloud site (Odoo, authentik, Postgres); on-prem site (SQL Server, Splunk); loaders for Salesforce, QBO, Shopify, Jira, Postgres, SQL Server, SharePoint.
2. **Web:** storefront (static Next.js on Cloudflare, Supabase), GA4, Shopify headless integration.
3. **Identity & security:** Okta dev org, Entra, Splunk log emitters.
4. **Processes:** simulator with the flows in §5; add HubSpot, ServiceNow, Stripe.
5. **Evals:** ~100-question bank with ground truth; SUT-agnostic runner; first SUT adapter.
6. **Breadth:** add systems as needed.

## 9. Decision Log

Entries are append-only; later entries supersede earlier ones.

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-23 | Fictional B2B distributor / light manufacturer | Naturally spans all target system categories. |
| 2026-09-23 | Prefer free / open source / dev-tier systems | Cost; repeatability. |
| 2026-09-23 | HR = Odoo Community; payroll in Postgres | Open source; Odoo Payroll is Enterprise-only. |
| 2026-09-23 | Identity = authentik (primary) + Okta Developer (secondary) + Entra | authentik has native outbound SCIM; Okta = common enterprise IdP; Entra included in E5 sandbox. Keycloak rejected: SCIM only via community extensions. |
| 2026-09-23 | SIEM = Wazuh / Splunk dev license | Splunk is the enterprise standard; Wazuh for open source path. Commercial observability orgs (e.g. Datadog) excluded to avoid polluting operator production data; CloudWatch-style services treated as log sources, not the SIEM. |
| 2026-09-23 | Collaboration = M365 Developer Program E5 sandbox | Free with VS subscription / partner eligibility; covers SharePoint, OneDrive, Teams, Entra P1/P2; isolated from operator production tenant. |
| 2026-09-23 | Register a real domain; Cloudflare as registrar/DNS/edge | Required for IdP domain verification, email, and public HTTPS. Cloudflare is at-cost, free tier covers DNS, Email Routing, Tunnel, and Access, and it doubles as the company's edge/security vendor. |
| 2026-09-23 | Split mail: root → M365, `svc.` → Cloudflare catch-all | 25-mailbox limit in E5 sandbox; unlimited sign-up addresses without licenses. |
| 2026-09-23 | Setup must be repeatable; runbook in SETUP.md | Future goal: automate end to end (e.g. as an agent skill). |
| 2026-09-23 | Setup order: domain → `svc.` catch-all → vault → M365 | Catch-all enables all later sign-ups; vault holds every credential from the start. |
| 2026-09-23 | All sign-ups use `svc.<domain>` addresses from day one | Root MX moves to M365 later; `svc.` survives the cutover. |
| 2026-09-23 | Cloudflare account owned by an operator mailbox outside `<domain>` (break-glass) | Avoid circular recovery dependency on mail routed through Cloudflare. |
| 2026-09-23 | M365 personas created by script from canonical roster (configurable sandbox), passwords generated and written to vault | Entra can't export passwords; instant-sandbox sample users don't match canonical data. |
| 2026-09-23 | Project is company- and SUT-agnostic; intended for a public repo | Reusable for testing any SaaS product; deployment-specific values stay in `local/` and the vault. |
| 2026-09-23 | Operator vault = local KeePassXC database (outside repo), behind a vault adapter | Free, open source, encrypted, scriptable, TOTP support; migrates to 1Password/Bitwarden later. Plaintext credential files rejected. |
| 2026-09-23 | Add storefront: Next.js + Supabase, Shopify headless, GA4 | Real web presence and ecommerce flow; adds CIAM, Supabase Postgres, and GA4 as data sources. |
| 2026-09-23 | Cloud site hosting = OCI Always Free (Ampere A1) + Terraform | Generous free compute/storage; Autonomous DB as bonus source. Constraints: arm64, 24 GB RAM, idle reclamation. |
| 2026-09-23 | Storefront hosted on Cloudflare Workers (OpenNext), not Vercel | Consolidates on Cloudflare; commercial use allowed on all plans (Vercel Hobby is non-commercial). Workers Paid likely needed. |
| 2026-09-23 | Add on-prem site: x86 Docker Compose with SQL Server + Splunk Enterprise | Splunk Enterprise and SQL Server don't run on arm64. On-prem site tests gateway/agent connectivity into a private network. Supersedes "SIEM = Wazuh / Splunk": Splunk primary, CloudWatch secondary, Wazuh optional. |
| 2026-09-23 | SQL Server role = legacy on-prem MES/WMS (`Operations` DB) + scale tests | Gives SQL Server a realistic purpose; enables hybrid cloud/on-prem questions. |
| 2026-09-23 | On-prem access: SUT gateway primary; Cloudflare Tunnel optional for direct access | Mirrors real enterprise networks (outbound-only); Tunnel covers HTTP(S) services when direct access is wanted. |
| 2026-09-23 | SIEM = Splunk Enterprise only; CloudWatch and Wazuh removed | Splunk covers the SIEM need; fewer systems to run and maintain. Supersedes earlier SIEM entries. |
| 2026-09-23 | Storefront = static Next.js export on Cloudflare Workers static assets; secret-bearing logic in Supabase Edge Functions | $0 hosting. Supersedes "Cloudflare Workers (OpenNext)". Azure Static Web Apps rejected: needs an Azure subscription (not included with E5) and hybrid Next.js is in preview. Details in apps/storefront/DESIGN.md. |
| 2026-09-23 | Component-level design docs live with the component (e.g. `apps/storefront/DESIGN.md`) | Keeps tech decisions next to the code they govern; top-level DESIGN.md stays environment-wide. |
| 2026-09-23 | Commit `.mcp.json` with SUT-agnostic, secret-free MCP servers (Cloudflare, Supabase, CLI for Microsoft 365, Microsoft Learn, GitHub, Stripe, Shopify Dev, Terraform, Playwright) | Enables agent-assisted setup; OAuth or env-var auth only. SUT MCP servers are added at local scope. Azure MCP omitted until an Azure-hosted component exists. |
| 2026-09-23 | Remove GitHub, Playwright, and Terraform MCP servers from `.mcp.json` | No setup need: GitHub is covered by `gh`/API in loaders; Playwright is used as a test library, not an agent tool; Terraform MCP only serves registry docs. Terraform itself stays for OCI provisioning. |
| 2026-09-23 | Operator vault = self-hosted Passbolt CE from Phase 2, at permanent URL `vault.<domain>` | Team-ready and enterprise-like from the start; open source; API/CLI for automation. Supersedes KeePassXC. Permanent URL because changing a Passbolt domain breaks extension enrollment. Setup order becomes domain → vault → email catch-all. |
| 2026-09-23 | Phase 0 automated: cross-platform prereq scripts (check-only by default, `--install` opt-in) + `setup-prerequisites` skill | Repeatable operator onboarding; first step toward per-phase setup skills. Skill is user-invoked only because it installs software. |
| 2026-09-23 | Phase 1 automated via `setup-company-domain` skill; domains registered through the Cloudflare Registrar API (via Cloudflare MCP); `godaddy` MCP added for public availability/suggestions | Registrar API (beta, April 2026) supports search/check/register. GoDaddy's MCP is public and read-only: good for ideation, but Cloudflare's check is authoritative because registration happens there. Cloudflare account setup (payment, registrant contact, agreement) moves to Phase 0. |
| 2026-09-23 | All setup scripts and skills are idempotent (read state → skip done → act → verify → record) | Phases are re-runnable after interruption without duplicates; essential where actions cost money or are irreversible (domain registration). |
| 2026-09-23 | Phase 2 automated via `setup-vault` skill; shared helpers in Node (`vault.mjs`, `set-env.mjs`) | Node is already a prerequisite on every platform, so one implementation instead of PowerShell + bash. Browser-only steps (registration, recovery kit, MFA) and the hosts file stay manual. |
| 2026-09-23 | Vault publishes HTTPS only; local port conflicts are solved with an alternate loopback address (e.g. `127.0.0.2`), not an alternate port | The hosts file maps names to IPs, not ports; a port would become part of the permanent Passbolt URL and break enrollment when the vault moves. |
| 2026-09-23 | Vault TLS = Let's Encrypt via Cloudflare DNS-01, terminated by Traefik in the vault stack; mkcert only as offline fallback | Self-signed certificates broke TOTP enrollment. DNS-01 works for a hosts-file-only name, is trusted everywhere (browsers, extension, Go CLI, Node) with no trust-store changes, auto-renews, and survives moving the vault. mkcert would trust only one machine and modify its trust stores. |
| 2026-09-24 | Phase 3 automated via `setup-email-routing` skill (Cloudflare MCP); delivery proven by test, with per-address rules as fallback | Unclear whether the zone catch-all covers subdomain addresses; sign-up addresses are known in advance, so literal rules always work. Generic "automation" Cloudflare API token dropped: tokens are created per purpose, least privilege, when a script needs one. |
| 2026-09-24 | Org model as hand-authored YAML in `canonical/org/`: 9 departments, group catalog, 25 personas = 25 E5 licenses; ~375 generated employees | Defined before provisioning because every IdP, group, SCIM scope, and permission test derives from it. Each persona carries a test purpose, so coverage is deliberate. |
| 2026-09-24 | Phase 4 automated via `setup-m365` skill; Graph work through `scripts/m365/` (domain, provision) as a sandbox-local app `ve-provisioning`, not the `m365` CLI | The CLI keeps one active connection per OS user, and `m365 setup` writes global config, so it could act on the operator's production tenant. A tenant-local app plus a token-tenant check makes wrong-tenant writes impossible. DNS goes through the Cloudflare MCP. Group-based E5 licensing on `app-m365`. `yaml` is the one npm dependency (local to `scripts/`). |
| 2026-09-24 | Existing sandboxes (including instant ones with sample users) are adopted and cleaned with `scripts/m365/cleanup.mjs`, not recreated | Recreating isn't practical: a deleted sandbox means a 60–90 day wait, and a second account must itself be eligible. Cleanup deletes and purges unmanaged users and groups (protecting personas, directory-role holders, `ops@`), freeing licenses for the personas. |
| 2026-09-24 | Passbolt SMTP and persona MFA policy deferred out of Phase 4 | All 25 E5 licenses go to personas, leaving no mailbox for SMTP AUTH (and basic SMTP AUTH is being retired); the MFA approach belongs with the identity work in Phase 6. |
| 2026-09-24 | `ops@<domain>` routing switch and DMARC tightening deferred from Phase 4 to Phase 6 | Making `ops@` a Cloudflare destination needs someone to read its verification email, which means a persona sign-in, and that hits the forced MFA registration. Routing keeps forwarding to the operator mailbox and DMARC stays `p=none` until the persona MFA policy is decided. Root-domain delivery is proven with a message trace instead. |
| 2026-09-24 | Passbolt default metadata type set to legacy cleartext (v4); encrypted metadata stays enabled | `go-passbolt-cli` can't trust the server-issued metadata key ([#79](https://github.com/passbolt/go-passbolt-cli/issues/79)), so v5 items the automation user creates can't be shared with the admin. v4 items share normally. Revisit when the CLI supports metadata key trust. |
| 2026-09-24 | `ve-provisioning` holds the User Administrator role in the sandbox | Graph refuses to reset existing users' passwords (`--rotate`) without a directory role; application permissions alone give 403. The role is scoped to the sandbox tenant only. |
| 2026-09-23 | Remove Vaultwarden from the stack | Avoid two password managers; the operator vault must not double as a company system exposed to the SUT. |

## 10. Open Questions & Risks

- [ ] **Company name & domain:** choose a clearly fictional name; confirm no real business or trademark conflict.
- [ ] **On-prem host:** VM with no public IP (e.g. VS subscription Azure credits, auto-shutdown schedule) vs. physical/Hyper-V box.
- [ ] **SUT gateway requirements:** OS, resources, outbound ports/domains; same host as Compose or separate machine (`BIND_ADDR`).
- [ ] **Splunk image version:** pin `SPLUNK_IMAGE_TAG`; confirm the dev license applies to the Docker image.
- [ ] **SUT connector coverage:** for each SUT, verify support for Odoo, authentik, Okta, Entra ID, Splunk, SQL Server, ServiceNow, Shopify, Supabase/Postgres, GA4, Oracle, Cloudflare.
- [ ] **Operator mailbox:** address outside `<domain>` that owns the break-glass accounts.
- [ ] **Vault hosting:** when/where the vault moves off the operator machine (on-prem host vs cloud site); verify the Passbolt image on arm64 if the cloud site.
- [ ] **SMTP relay:** Exchange Online is retiring basic-auth SMTP AUTH (verify current status). Passbolt, authentik, and Supabase Auth need SMTP; options are M365 with OAuth-capable clients only, or a free transactional relay (e.g. Brevo, SMTP2GO) with `<domain>` verified in Cloudflare DNS.
- [ ] **Passbolt TOTP resources:** confirm the CE version supports storing TOTP seeds (for persona MFA).
- [ ] **Persona MFA:** vaulted TOTP seeds vs. Conditional Access exemption for test personas.
- [ ] **Storefront:** see open questions in [apps/storefront/DESIGN.md](apps/storefront/DESIGN.md) §11 (Shopify dev store checkout, Supabase pause, GA4 bot filtering).
- [ ] **OCI arm64 compatibility:** verify Odoo on arm64.
- [ ] **OCI account:** PAYG upgrade to avoid idle reclamation; home region choice; A1 capacity.
- [ ] **Primary purpose:** QA regression vs. demos vs. AI answer-quality evals.
- [ ] **M365 E5 eligibility:** confirm the operator's VS subscription / partner benefit qualifies.
- [ ] **Renewals:** track domain, M365 90-day, Splunk license, Snowflake trial, ServiceNow PDI.
- [ ] **ERP choice:** QBO sandbox vs. ERPNext.
- [ ] **License:** choose an open source license for the public repo.
