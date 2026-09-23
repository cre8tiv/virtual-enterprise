---
name: setup-company-domain
description: Run SETUP.md Phase 1 for the virtual enterprise. Iterate on fictional company names, vet them against real businesses and trademarks, synthesize and check domain names, register the chosen domain with Cloudflare Registrar, and record company name and domain in local/registry.md and derived config. Use when starting Phase 1 or resuming an interrupted one.
disable-model-invocation: true
---

# Setup: Phase 1 Company Name & Domain

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 1. Run from the repo root.

**Idempotent by design:** every run starts from current state (the registry, `local/names.md`, and the Cloudflare account) and resumes at the first unfinished step. A registration is a **purchase that can't be refunded**, so it happens only after the operator's explicit yes, and only after confirming the account doesn't already hold the domain.

Tools: `cloudflare` MCP (Registrar search/check/register, zones), `godaddy` MCP (public availability and suggestions, read-only), web search (vetting).

## Steps

### 1. Preconditions and state

1. `local/registry.md` exists (Phase 0). If not, stop and point the operator to `/setup-prerequisites`.
2. The `cloudflare` MCP server is authenticated: call a read-only tool to get the account ID. If it fails, ask the operator to complete OAuth with the environment's Cloudflare account, granting Registrar and DNS/zone edit.
3. Ask the operator to confirm the Registrar prerequisites from Phase 0 are in place: default payment method, default registrant contact, Domain Registration Agreement accepted.
4. Read state and branch:
   - Registry has **Company name** and **Domain**, and the domain is registered in this Cloudflare account → go to step 6.
   - Registry has a Domain that is **not** in this account → stop and ask the operator (registered elsewhere, or a different account).
   - Registry is empty but the account already has a registered domain → ask whether it belongs to this environment; if yes, adopt it (ask for the company name if unknown) and go to step 6.
   - `local/names.md` exists → load the candidates and vetting results; resume at the step they imply.

Done when you know the account ID and which step to resume at.

### 2. Name candidates

The company is a fictional B2B industrial distributor / light manufacturer ([DESIGN.md](../../../DESIGN.md) §2). Ask the operator for preferences (tone, words to use or avoid), then propose 5–8 names: pronounceable, clearly invented, and not echoing famous brands. Iterate until the operator has a shortlist of up to 5.

Record the shortlist in `local/names.md` (create it; append on later runs).

### 3. Vet names

For each shortlisted name, search the web for:

- the name as a company or brand (with and without industry words);
- trademarks (`"<name>" trademark`, USPTO / EUIPO results);
- company registries (e.g. OpenCorporates);
- an operating website at the obvious `.com`.

Classify each as **clear** (no meaningful match), **conflict** (an active business or mark with the same or confusingly similar name, especially in industrial, manufacturing, or distribution), or **uncertain**, with evidence links. Record the results in `local/names.md`. Vetting is best effort; the operator makes the final call.

Done when the operator picks one **clear** name (or accepts an uncertain one after seeing the evidence).

### 4. Domain candidates

1. Synthesize 5–10 domains from the chosen name: the exact `.com` first, then natural variants (`<name>industrial`, `<name>group`, `<name>mfg`, hyphen-free) and other TLDs (`.co`, `.net`, `.io`).
2. Quick filter with the `godaddy` MCP (availability and suggestions).
3. Authoritative check with the Cloudflare Registrar **check** tool (up to 20 domains per call): availability, Cloudflare support for the TLD, and at-cost price. A domain is a candidate only if Cloudflare can register it; premium domains are excluded.
4. Show a table (domain, available, price/year) and record it in `local/names.md`.

Done when the operator picks one domain.

### 5. Register (explicit confirmation)

1. Present exactly: domain, first-year price, 1-year term, **auto-renew on**, WHOIS privacy (redaction), non-refundable. Wait for an explicit yes.
2. Immediately before registering: re-run **check** for that domain, and confirm the account doesn't already hold it. If it does (for example, a previous run registered it), skip to step 6.
3. Register with `auto_renew: true`. If the response is `202`, poll the registration status until it is terminal: `succeeded` → continue; `action_required` / `blocked` / `failed` → relay the details to the operator and stop. Submit only one registration per domain; on a re-run, pending state comes from the account, not a new request.

Done when the registration status is `succeeded`.

### 6. Verify and record

1. Confirm the domain appears in the account's registrations and note its expiry date.
2. Confirm a DNS zone exists for the domain. If none exists, create it (tell the operator first). Note the zone ID.
3. Update `local/registry.md`: **Company name**, **Domain**, **Cloudflare account ID**, **Cloudflare zone ID**, and the domain's expiry in the Renewal column. Replace `<domain>` in existing registry values with the domain.
4. Write derived config into each component's gitignored `.env`. The committed `.env.example` files are public templates and keep their placeholders. For each file below: if `.env` doesn't exist, copy it from `.env.example`; then set only the listed keys, leaving other lines untouched:

   | File | Keys |
   |---|---|
   | `apps/storefront/.env` | `COMPANY_NAME=<company name>`, `SITE_URL=https://www.<domain>` |
   | `infra/compose/vault/.env` | `APP_FULL_BASE_URL=https://vault.<domain>` |

   If `infra/compose/vault/.env` already has a different `APP_FULL_BASE_URL` and the vault has been started (`docker compose ps` in that folder shows containers), stop and ask the operator: the vault URL is permanent once users enroll.
5. Mark the chosen name and domain as `registered` in `local/names.md`.

Done when every value above is written and matches the Cloudflare account.

### 7. Report

Summarize the company name, domain, expiry, and files updated. Remind the operator that the Cloudflare login and 2FA recovery codes stay in their personal password manager until Phase 2. Next step: **Phase 2: Operator Vault**.
