---
name: setup-okta
description: Run SETUP.md Phase 6c for the virtual enterprise. Sets up the Okta Integrator Free Plan org as the secondary workforce IdP, adds a Custom OTP authenticator and MFA policy, and provisions the catalog groups and the 10-persona Okta subset with vaulted passwords and their shared TOTP seeds, then verifies an MFA sign-in. Use when starting 6c, resuming it, or re-syncing after canonical/org changes.
disable-model-invocation: true
---

# Setup: Phase 6c Okta

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 6c. Run from the repo root.

**Scope:** the Integrator Free Plan allows **10 active users**, so Okta holds the persona subset in `canonical/org/personas.yaml` (`idp_subsets.okta`), all catalog groups, and each persona's shared TOTP seed through a Custom OTP authenticator.

**Idempotent by design:** `scripts/okta/provision.mjs` plans from live state and applies only differences. The portal steps are checked before they're repeated.

**Secret hygiene:** the operator pastes the Okta API token straight into Passbolt; scripts read it from the vault.

## Steps

### 1. Preconditions

Phase 6a is done (persona TOTP seeds exist); `node scripts/vault/vault.mjs whoami` prints `ok`.

### 2. Okta org (operator)

Skip if the registry has **Okta org URL**.

1. If **Email Routing mode** is `per-address rules`, add a forwarding rule for `okta-admin@svc.<domain>`.
2. The operator signs up for the Okta Integrator Free Plan (https://developer.okta.com/signup/) with `okta-admin@svc.<domain>` (a business email, unique per org), activates the account from the email, sets a password and Okta Verify for the admin, and stores the credentials in Passbolt `Break-glass`.
3. Record **Okta org URL** = `https://<org>.okta.com` (the admin console is the same host with `-admin`; record the one without).

### 3. API token and Custom OTP (operator)

1. **API token:** Admin console → Security → API → Tokens → Create token `ve-provisioning`. The operator saves it in Passbolt `Service & API` as **`Okta API token`** (username = org URL). It carries the creating admin's permissions and expires after 30 days without use, so the provisioner keeps it alive when run.
2. **Custom OTP authenticator:** Security → Authenticators → Add authenticator → **Custom OTP**: HMAC algorithm SHA1, passcode length 6, time step 30 seconds. Add it.
3. **Factor profile ID:** the Factors API needs it to enroll Custom OTP with our seed. Find it for an existing user through `GET /api/v1/users/<user id>/factors/catalog` (the `token:hotp` / `CUSTOM` entry), or on the authenticator's details in the admin console. Record it as **Okta custom OTP factor profile**. This lookup hasn't been exercised yet, so note what worked in the report.
4. **MFA policy:** Security → Authentication Policies → **Okta Dashboard** (and **Default Policy**): the catch-all rule requires **Password + Another factor**, with Custom OTP among the allowed factors. Security → Authenticators → Enrollment → default policy: Custom OTP **Optional** (the provisioner enrolls it).

### 4. Provision

1. `node scripts/okta/provision.mjs` (plan). Summarize the groups, the 10 users, memberships, passwords, and Custom OTP enrollments.
2. On an explicit yes, `--apply`. Passwords are stored in the vault's `Personas` folder as `okta: <upn>` before users are created.
3. Re-run until `No changes`. If Custom OTP enrollment fails on the secret format, report the error: Okta may expect the shared secret in another encoding than base32.

### 5. Verify an MFA sign-in (operator)

In a private window, sign in at the Okta org URL as a subset persona (username = UPN, password from Passbolt `Personas` / `okta: <upn>`), choose the Custom OTP factor, and enter the code from `node scripts/lib/totp.mjs code <upn>`.

Done when the persona reaches the Okta end-user dashboard.

### 6. Record and report

Summarize the org, the subset, and the verified sign-in. Note the API token's inactivity expiry and that SSO/SCIM apps for the SUT come in Phase 12.

Next step: **Phase 7: HR** (after 6b if not done).
