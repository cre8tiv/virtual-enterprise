---
name: setup-m365
description: Run SETUP.md Phase 4 for the virtual enterprise. Stands up or adopts the M365 E5 developer sandbox (removing instant-sandbox sample users), adds the company domain (verification, mail DNS, DKIM), provisions the org model's groups and 25 persona users with group-based licensing, creates the ops@ shared mailbox, and moves email routing and DMARC to their final state. Use when starting Phase 4, resuming it, or re-syncing personas after canonical/org changes.
disable-model-invocation: true
---

# Setup: Phase 4 Microsoft 365 E5 Sandbox

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 4. Run from the repo root.

**Idempotent by design:** every step reads live state first (registry, Graph via `scripts/m365/*`, Cloudflare via the `cloudflare` MCP) and changes only what differs. Re-running the skill after editing `canonical/org/` re-syncs the tenant.

**Tenant safety:** Graph work runs only through `scripts/m365/*`, authenticated as the `ve-provisioning` app **registered inside the sandbox**. Its token is checked against **M365 tenant ID** in the registry, and provisioning also requires `<domain>` to be verified in that tenant. Don't use the `m365` CLI or the `m365-sandbox` MCP server for this phase; they share one active connection with the operator's other tenants.

**Secret hygiene:** secrets go straight from the portal into Passbolt (operator) or from a script into the vault (automation). Keep them out of replies and command output.

Helpers:

- `node scripts/lib/registry.mjs get|set "<Key>" ["<Value>"]`: read/write `local/registry.md`
- `node scripts/m365/domain.mjs status|add|verify|default`: domain in the tenant; `status` prints the DNS records M365 needs as JSON
- `node scripts/m365/cleanup.mjs [--apply] [--keep <upn>]... [--no-purge]`: removes users and groups the org model doesn't manage (e.g. instant-sandbox samples); prints a plan unless `--apply`
- `node scripts/m365/provision.mjs [--apply] [--prune] [--rotate <upn|all>]`: groups, personas, memberships, managers, licensing; prints a plan unless `--apply`

## Steps

### 1. Preconditions

1. `local/registry.md` has **Domain**, **Company name**, **Email Routing mode**, and **Email routing destination** (Phases 1–3).
2. `node scripts/vault/vault.mjs whoami` prints `ok` (Phase 2).
3. `scripts/node_modules/yaml` exists; otherwise run `npm install --prefix scripts` (local to the repo).

Done when all three hold.

### 2. Sandbox tenant (operator)

If the registry already has **M365 tenant ID**, ask the operator to confirm it's still the active sandbox, complete item 5 below if **M365 developer program account** is empty, and go to step 3.

**New sandbox:**

1. If **Email Routing mode** is `per-address rules`, first make sure `m365-admin@svc.<domain>` has a forwarding rule (as in `/setup-email-routing` step 7).
2. The operator confirms eligibility (Visual Studio Pro/Enterprise subscription or partner benefit), joins the Microsoft 365 Developer Program with `m365-admin@svc.<domain>`, and creates a **configurable (empty)** E5 sandbox.

**Existing sandbox (adopt it):** the operator may already have one, possibly an **instant** sandbox with Microsoft's sample users and content, or one registered under another email. Recreating isn't practical (deleting a sandbox means waiting 60–90 days before a new one; a second account must itself be eligible), so adopt it. Step 7 removes the sample users and groups.

For either path:

3. The operator stores the sandbox's global admin credentials (`admin@<tenant>.onmicrosoft.com` is fine and preferred: it doesn't depend on the custom domain) in Passbolt `Break-glass`.
4. From the Entra admin center Overview, the operator gives you the **Tenant ID** and the initial domain (`<tenant>.onmicrosoft.com`), and from the developer dashboard the sandbox **expiry date**. Record them: **M365 tenant ID**, **M365 tenant name**, and the expiry in the Renewal column of **M365 tenant ID**.
5. Record the email the Developer Program is registered under as **M365 developer program account**. Renewal and expiry warnings go there. If it's a mailbox **inside** the sandbox (e.g. the onmicrosoft admin), ask the operator to change the profile's contact email to `m365-admin@svc.<domain>` if the dashboard allows it. Otherwise note that this mailbox must stay licensed (step 8).

Done when all four values are in the registry.

### 3. Automation app `ve-provisioning` (operator, in the portal)

Skip if `node scripts/m365/domain.mjs status` already succeeds.

Guide the operator through the Entra admin center, signed in as the sandbox admin:

1. App registrations → New registration: name `ve-provisioning`, single tenant, no redirect URI.
2. API permissions → Add → Microsoft Graph → **Application permissions**: `User.ReadWrite.All`, `Group.ReadWrite.All`, `Directory.ReadWrite.All`, `Domain.ReadWrite.All`, `Organization.Read.All` → **Grant admin consent**.
3. Certificates & secrets → New client secret (maximum lifetime) → copy the **Value**.
4. In Passbolt, folder `Service & API`, create resource **`Entra app: ve-provisioning`**: username = Application (client) ID, password = secret value, description = secret expiry date.

Then run `node scripts/m365/domain.mjs status`. It fails with a clear message if the token is for another tenant. Record the secret expiry as the Renewal of a **ve-provisioning secret** row.

Done when `status` prints JSON.

### 4. Domain verification

1. `status` → if `added` is false, run `add`, then `status` again.
2. If not verified: create the returned TXT record in Cloudflare (zone `<domain>`, skip if an identical record exists). Wait until it resolves: `node -e "require('dns').promises.resolveTxt('<domain>').then(r=>console.log(r.flat().join('\n')))"`. Then run `verify`, retrying for a few minutes if needed.
3. `default` to make `<domain>` the tenant default.

Done when `status` shows `verified: true, default: true`.

### 5. Mail and service DNS records

1. If the registry's **Email Routing apex** is `enabled`, disable Email Routing for the apex only (keep `svc.<domain>`) so the root MX isn't locked, then set the row to `disabled`.
2. `status` now returns the service records. For each record (Email first, then Teams/Skype and Intune for a complete setup), create it in Cloudflare if missing: **DNS only (not proxied)**, TTL as given, SRV fields as given. If a different record already holds the same name and type (for example another root MX or SPF), show both to the operator and replace it only on their yes.
3. Confirm the root MX resolves to Exchange Online: `node -e "require('dns').promises.resolveMx('<domain>').then(console.log)"`.

Done when every Email record exists in Cloudflare and the MX resolves.

### 6. DKIM

1. The operator opens the Microsoft Defender portal → Email & collaboration → Policies & rules → Threat policies → Email authentication settings → DKIM → `<domain>`, and reads you the two CNAME records it shows (host `selector1._domainkey` / `selector2._domainkey` and their targets; these aren't secret).
2. Create both CNAMEs in Cloudflare, DNS only, if missing. Wait until both resolve (`dns.promises.resolveCname`).
3. The operator enables "Sign messages for this domain with DKIM signatures".

Done when the operator confirms DKIM shows **Enabled**.

### 7. Remove unmanaged objects

Run `node scripts/m365/cleanup.mjs` (plan). It lists users and groups the org model doesn't manage (typically an instant sandbox's sample users, Microsoft 365 groups, and Teams) and never touches personas, users holding a directory role (the global admin), or `ops@<domain>`.

- `Nothing to clean up` → go to step 8.
- Otherwise show the operator the full list. Deleting a Microsoft 365 group also deletes its Team and SharePoint site. Ask whether any account should stay (`--keep <upn>`), then on an explicit yes run with `--apply`. Deleted objects are purged from the recycle bin so their licenses and names are free now; if purge is denied, relay the script's note (grant `User.DeleteRestore.All`, or let them expire in 30 days).
- Relay the script's other notes: mail-enabled groups go through the Exchange admin center; leftover sample SharePoint sites through SharePoint admin center → Active sites.

Done when the plan prints `Nothing to clean up` (apart from the Exchange-only groups the operator chose to handle or keep).

### 8. Provision the org model

1. Run `node scripts/m365/provision.mjs` (plan). Show a summary: groups, users, memberships, and managers to create, plus license warnings.
2. **Licenses:** if the plan warns that non-persona users (typically the sandbox admin) hold E5 licenses and there aren't enough free for 25 personas, ask the operator to remove the license from those accounts in the M365 admin center. The admin role doesn't need a license. **Exception:** if the admin's mailbox is the **M365 developer program account** (step 2), removing its license loses renewal warnings; keep it licensed and accept 24 licensed personas, or change the program's contact email first.
3. On an explicit yes, run with `--apply`. Persona passwords are generated and stored in the vault's `Personas` folder before each user is created.
4. Re-run the plan until it prints `No changes`. Group-based licensing can take several minutes; a later plan shows the consumed count reaching the persona total.

Done when the plan shows no changes and every licensed persona holds a license.

### 9. Shared mailbox `ops@<domain>` (operator)

1. M365 admin center → Teams & groups → Shared mailboxes → Add: display name `Operations`, email `ops@<domain>`. Add members with full access: the `it-director` and `sysadmin` personas.
2. **Mail flow test:** the operator sends an email from an external mailbox to `ops+phase4@<domain>`, signs in to Outlook on the web as the `it-director` persona (credentials from the vault's `Personas` folder; skip the MFA registration prompt for now), opens the shared mailbox, and confirms it arrived. This proves root-domain delivery and plus-addressing.

Done when the operator confirms the test email arrived.

### 10. Final email routing and DMARC

1. In Cloudflare, add `ops@<domain>` as a destination address. The verification email lands in the shared mailbox, and the operator clicks it.
2. Point the catch-all and every literal `svc.<domain>` rule at `ops@<domain>` (leave rules already pointing there alone). Record **Email routing destination** = `ops@<domain>`.
3. With DKIM enabled and the step 9 test passed, ask whether to tighten DMARC. On yes, update `_dmarc.<domain>` to `p=quarantine` (keep the `rua`).

Done when routing forwards to `ops@<domain>` and DMARC matches the operator's choice.

### 11. Record and report

1. Record the **Persona roster version**: `node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('canonical/org/personas.yaml')).digest('hex').slice(0,12))"`.
2. Summarize the tenant, domain state, provisioning result, and renewal dates (sandbox expiry, app secret expiry).
3. Name what's deferred, with the reason:
   - **Passbolt SMTP:** all 25 licenses belong to personas, so there's no mailbox for SMTP AUTH, and basic SMTP AUTH is being retired. Waits on the relay decision (DESIGN.md §10).
   - **Persona MFA policy:** security defaults still prompt each persona to register MFA on interactive sign-in. Decided in Phase 6 (TOTP seeds in the vault vs. Conditional Access).

Next step: **Phase 5: Infrastructure**.
