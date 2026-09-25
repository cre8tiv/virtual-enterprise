---
name: setup-entra-mfa
description: Run SETUP.md Phase 6a for the virtual enterprise. Enforces MFA in the M365 sandbox the scripted way (per-persona TOTP seeds in the vault, registered as Entra hardware OATH tokens, Conditional Access replacing security defaults), verifies an MFA sign-in, then finishes the items deferred from Phase 4 (ops@ as the email routing destination, DMARC tightening). Use when starting Phase 6, resuming 6a, or rotating persona TOTP seeds.
disable-model-invocation: true
---

# Setup: Phase 6a Entra MFA

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 6a. Run from the repo root. Do 6a before 6b (authentik) and 6c (Okta): it creates the persona TOTP seeds they reuse.

**The policy (DESIGN.md §2.1):** every persona has one TOTP seed in the vault (`Personas` / `TOTP: <upn>`), shared by Entra, authentik, and Okta. MFA is enforced by Conditional Access, and automated sign-ins compute the code from the seed. The Global Administrator (break-glass) is excluded from Conditional Access, but keeps its own MFA method for Microsoft's mandatory admin-portal MFA.

**Idempotent by design:** `mfa.mjs` plans from live state (method policy, tokens, CA policies, security defaults) and applies only differences. Conditional Access is enabled only after every persona has an activated token, so nobody gets stuck on a registration prompt.

Helpers:

- `node scripts/m365/mfa.mjs [--apply] [--rotate <upn|all>]`: seeds, hardware OATH tokens (Graph **beta**, preview), Conditional Access, security defaults
- `node scripts/lib/totp.mjs code <upn>`: current 6-digit code for a persona (prints the code, never the seed)
- Portals: Entra admin center https://entra.microsoft.com/, Outlook on the web https://outlook.office.com/

Windows note: run the `node scripts/...` commands from the PowerShell tool after refreshing PATH, as in `/setup-m365`.

## Steps

### 1. Preconditions

1. Phase 4 is done: `node scripts/m365/provision.mjs` prints `No changes` (apart from the group-license line).
2. `node scripts/vault/vault.mjs whoami` prints `ok`.

### 2. App permissions (operator)

Run `node scripts/m365/mfa.mjs`. If it stops with "lacks application permissions", the operator adds the listed permissions in the Entra admin center: App registrations → `ve-provisioning` → API permissions → Add → Microsoft Graph → **Application permissions**: `Policy.ReadWrite.AuthenticationMethod`, `UserAuthenticationMethod.ReadWrite.All`, `Policy.ReadWrite.ConditionalAccess`, `Policy.Read.All`, `Application.Read.All` → **Grant admin consent**. Re-run after a minute (each run gets a fresh token).

Done when the plan prints without a permission error.

### 3. Break-glass readiness (operator)

Before anything is enforced, the operator confirms the sandbox's Global Administrator has its own MFA method registered (Microsoft Authenticator or a TOTP app, via https://mysignins.microsoft.com/security-info) and that its credentials are in Passbolt `Break-glass`. The script excludes Global Administrators from both Conditional Access policies and refuses to run if it finds none.

### 4. Seeds, tokens, Conditional Access

1. Show the plan summary: method policy change, seeds to create (vault first), tokens to create/assign/activate, CA policies to create, security defaults to turn off.
2. On an explicit yes: `node scripts/m365/mfa.mjs --apply`.
3. Re-run the plan until it prints `No changes`. Newly enabled methods can take **20 minutes to an hour** to propagate, so activation may fail on the first run; wait and re-run. Conditional Access stays off (the plan says so) until every persona's token is active.

Done when the plan prints `No changes`: 25 activated tokens, both `VE -` policies enabled, security defaults off.

### 5. Verify an MFA sign-in (operator)

In a private browser window, the operator signs in at https://myapps.microsoft.com/ as the `it-director` persona: password from Passbolt `Personas` (resource named by the UPN), then the verification code from `node scripts/lib/totp.mjs code <it-director UPN>`. If a method choice appears, pick the hardware token / verification code.

Codes last 30 seconds: run `totp.mjs code` when the operator is at the code prompt (or when asked), and if `(N s left)` is under about 12, wait for the next one. `mfa.mjs` turns the **authentication methods registration campaign** off (it otherwise nags every user to register a passkey, and that screen has no skip button); a browser window opened before that change can still show the stale prompt, so close it and sign in again in a new private window.

Done when the sign-in succeeds with the code and no "register MFA" or passkey prompt. If one still appears, check Entra → Protection → Authentication methods → Registration campaign and turn it off for all users (the tokens already satisfy MFA).

### 6. Finish Phase 4's deferred email items

1. Still signed in as `it-director`, open the shared mailbox: https://outlook.office.com/mail/ops@<domain>/ (the persona has full access).
2. Through the `cloudflare` MCP, add `ops@<domain>` as an Email Routing destination address. The operator opens the verification email in the shared mailbox and clicks it; re-read until the destination is `verified`.
3. Point the catch-all and every literal `svc.<domain>` rule at `ops@<domain>` (leave rules already pointing there alone). Record **Email routing destination** = `ops@<domain>`.
4. Ask whether to tighten DMARC now (DKIM is enabled and the Phase 4 mail test passed). On yes, update `_dmarc.<domain>` to `p=quarantine`, keeping the `rua`.

Done when routing forwards to `ops@<domain>` and DMARC matches the operator's choice.

### 7. Record and report

1. Record **Entra MFA** = `enforced (Conditional Access), 25/25 tokens` and re-record **Persona roster version** (the command in `/setup-m365` step 11; `personas.yaml` gained `idp_subsets`).
2. Summarize: tokens, policies, the verified sign-in, email routing, DMARC.
3. Rotating a persona's seed later: `mfa.mjs --apply --rotate <upn>`, then re-run the 6b and 6c provisioners so authentik and Okta pick up the new seed.

Next step: **Phase 6b: authentik** (`/setup-authentik`), then **6c: Okta** (`/setup-okta`).
