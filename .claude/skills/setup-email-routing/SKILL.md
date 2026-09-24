---
name: setup-email-routing
description: Run SETUP.md Phase 3 for the virtual enterprise. Enables Cloudflare Email Routing on svc.<domain>, verifies the operator mailbox as destination, forwards every svc.<domain> address to it (catch-all, or per-address rules if the catch-all doesn't cover the subdomain), adds DMARC, and proves delivery with a test email. Use when starting Phase 3, resuming it, or adding a sign-up address later.
disable-model-invocation: true
---

# Setup: Phase 3 Email Catch-All

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 3 using the `cloudflare` MCP server (Email Routing and DNS APIs). Run from the repo root.

**Idempotent by design:** read Cloudflare state before every change (routing settings, destination addresses, rules, DNS records) and change only what differs. The operator clicks the verification link and sends the test email; everything else goes through the API.

**Scope guard:** Email Routing is enabled **only on `svc.<domain>`**. The root domain's MX belongs to Microsoft 365 from Phase 4, so leave apex routing off. If Cloudflare insists on enabling the apex first, allow it, record it as **Email Routing apex** = `enabled (disable in Phase 4)` in the registry, and continue.

## Steps

### 1. Preconditions and state

1. `local/registry.md` has **Domain**, **Cloudflare account ID**, **Cloudflare zone ID**, and **Operator mailbox**. If not, point to the earlier phase's skill.
2. The `cloudflare` MCP server answers a read-only call for the zone.
3. Read the zone's Email Routing settings and DNS status for `svc.<domain>`, the account's destination addresses, the zone's catch-all rule, and the other rules. These decide which steps below are already done.

Done when you know the state of each item in steps 2–6.

### 2. Enable routing on `svc.<domain>`

If `svc.<domain>` isn't enabled, enable Email Routing for that subdomain (Email Routing DNS "enable" with `name: svc.<domain>`). Cloudflare adds and locks the subdomain's MX and SPF records. If the API refuses, have the operator add the subdomain in the dashboard (Email Routing → Settings → subdomains), then re-read the state.

Done when the DNS status for `svc.<domain>` shows the required MX and SPF records present (status `ready`).

### 3. Destination address

1. If the operator mailbox isn't a destination address in the account, create it. Cloudflare emails a verification link.
2. Ask the operator to click the link, then re-read the address.

Done when the destination is `verified`. Rules forward only to verified destinations.

### 4. Forwarding

1. Set the zone's catch-all rule to **forward** to the operator mailbox and **enabled**, unless it already is.
2. Always create (if missing) literal rules forwarding `dmarc@svc.<domain>` and `automation@svc.<domain>` to the operator mailbox. These addresses are already in use, so they must work even if the catch-all turns out not to cover the subdomain.

### 5. DMARC

If `_dmarc.<domain>` has no TXT record, create:
`v=DMARC1; p=none; rua=mailto:dmarc@svc.<domain>`
If one exists with different content, show it to the operator and change it only on their yes. Phase 4 tightens `p` once M365 signs mail.

### 6. Prove delivery

1. Generate a unique address: `phase3-test-<8 random chars>@svc.<domain>` (`node scripts/vault/vault.mjs generate 8` works offline).
2. Ask the operator to send an email to it from any mailbox other than the destination (Gmail, for example, may hide mail sent to itself), and to report whether it arrived.
3. Branch:
   - **Arrived** → the catch-all covers the subdomain. Record **Email Routing mode** = `catch-all`.
   - **Not arrived after a few minutes** (check the spam folder too) → send a second test to `dmarc@svc.<domain>`, which has a literal rule.
     - That arrives → the catch-all doesn't cover the subdomain. Record **Email Routing mode** = `per-address rules`. From now on, every sign-up address gets a literal rule **before** the sign-up (step 7).
     - That doesn't arrive either → routing is broken. Re-check steps 2–3 (records `ready`, destination `verified`) and the destination's spam folder before retrying.

Done when a test email arrived and the mode is recorded.

### 7. Sign-up addresses (per-address mode, or on request)

For each `<system>-admin@svc.<domain>` the runbook will use (`m365-admin`, `oci-admin`, `okta-admin`, `splunk-admin`, `ga-admin`, and each Phase 9 system), create the literal forwarding rule if it's missing. Later phases can re-run this skill to add one address; creating a rule that already exists is skipped.

### 8. Record and report

Update `local/registry.md`: **Email routing destination** (operator mailbox), **Email Routing mode**, and **Email Routing apex** if it was enabled. Summarize the state and name what remains for Phase 4 (switching the destination to `ops@<domain>`, tightening DMARC). Next step: **Phase 4: Microsoft 365 E5 Developer Sandbox**.
