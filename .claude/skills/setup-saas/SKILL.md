---
name: setup-saas
description: Run SETUP.md Phase 9 for the virtual enterprise. Walks the operator through SaaS sign-ups one service at a time from the service catalog (canonical/saas/services.yaml): email routing for the admin address, the sign-up itself (operator), creating the API credential (operator, straight into Passbolt), then proving it works with scripts/saas/verify.mjs and recording registry values. Core set: Salesforce, HubSpot, QuickBooks Online, ServiceNow, Jira, GitHub. Use when starting Phase 9, adding a service, or re-checking credentials.
disable-model-invocation: true
---

# Setup: Phase 9 SaaS Accounts

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 9. Run from the repo root.

**Division of work:** the operator signs up, verifies email, accepts terms, and creates each API credential in the vendor's console. Vendors forbid automated sign-up, and the credential goes straight into Passbolt. You prepare each step, give the exact click path, then **prove the credential works** and record what the next phases need.

**The catalog is the source of truth:** [`canonical/saas/services.yaml`](../../../canonical/saas/services.yaml) holds each service's sign-up URL, admin address, edition, credential names and fields, registry keys, lifecycle (expiry, hibernation), gotchas, and console path. Read the entry before each service; don't restate it from memory. When a vendor's flow has changed, update the entry.

**Idempotent by design:** a service is done when `node scripts/saas/verify.mjs <key>` prints `ok`. Re-running the skill checks first and walks only the services that aren't.

## Steps

### 1. Preconditions and choice

1. `local/registry.md` has **Domain** and **Email Routing mode**; `node scripts/vault/vault.mjs whoami` prints `ok`; `scripts/node_modules/yaml` exists (else `npm install --prefix scripts`).
2. Run `node scripts/saas/verify.mjs` to see what's `ok`, `missing`, or `FAILED`.
3. Show the operator the services that aren't `ok`, with each one's `needed_by` phase and `lifecycle`, and ask which to do now. Trial clocks and hibernation start at sign-up (ServiceNow's instance is reclaimed after about 10 idle days), so suggest postponing anything not needed soon. Record skipped services in the report.

### 2. Per service (repeat for each chosen one)

1. **Admin address:** `<admin_email>@svc.<domain>`. If **Email Routing mode** is `per-address rules`, create its forwarding rule first (as in `/setup-email-routing` step 7).
2. **Brief the operator:** the sign-up URL, the edition to choose, and every gotcha from the catalog entry.
3. **Sign-up (operator):** sign up, verify the email (it arrives through Email Routing), accept the terms. Save the admin login in Passbolt `Vendor admins` as `<name> admin`. Where the vendor offers an authenticator app, the operator uses "can't scan? show key" and saves the secret in that item's **TOTP** field, so MFA stays with the vault.
4. **API credential (operator):** walk the catalog's `console` path. The operator saves each credential in Passbolt `Service & API` under the exact name in `credentials[].vault`, with the `fields` mapping for username/password. The automation user reads it from there.
5. **Registry:** record the catalog's registry key and value (`node scripts/lib/registry.mjs set "<key>" "<value>"`; these aren't secret), and put the lifecycle date (trial end, token expiry) in the Renewal column where there is one.
6. **Prove it:** `node scripts/saas/verify.mjs <key>`.
   - `ok` → done; the detail names the account reached.
   - `missing` → a registry value or vault name doesn't match the catalog. Fix the name, don't copy secrets around.
   - `FAILED` → read the HTTP detail. Usual causes: wrong flow enabled (Salesforce Client Credentials or Run As user), missing scopes (HubSpot), an expired Playground refresh token (QuickBooks: get a new one), a hibernating instance (ServiceNow: wake it in the developer portal), or a token without org access (GitHub resource owner).

Done for a service when verify prints `ok`.

### 3. Report

Run `node scripts/saas/verify.mjs` once more and show the table. List services done, skipped (with their `needed_by` phase), and every lifecycle reminder now in the registry. Note that the storefront services (Shopify, Stripe, GA4, Supabase, Cloudflare Workers) and Snowflake are added to the catalog when their phase approaches.

Next step: **Phase 10: Canonical Data & Loaders**.
