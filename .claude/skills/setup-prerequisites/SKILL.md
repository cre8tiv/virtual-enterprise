---
name: setup-prerequisites
description: Run SETUP.md Phase 0 for the virtual enterprise on the operator's machine. Checks and installs required tools with scripts/prereqs, creates local/registry.md, records the operator mailbox and owners, and readies the Cloudflare account. Use when starting a new deployment or when a later phase fails because a tool is missing.
disable-model-invocation: true
---

# Setup: Phase 0 Prerequisites

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 0. The repo is already cloned; run every command from the repo root.

Installing software changes the operator's machine, so **every install waits for the operator's explicit yes**. Checks are read-only and run freely.

## Steps

### 1. Check tools

Run the check script for the platform:

- Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prereqs/prereqs.ps1`
- macOS / Linux: `bash scripts/prereqs/prereqs.sh`

Done when you have the result table and exit code. Exit 0 → go to step 3.

### 2. Install missing tools (with approval)

1. Show the operator the MISSING / OUTDATED / NOT RUNNING rows and what `--install` will do on their platform (winget or Chocolatey on Windows, Homebrew on macOS, apt/dnf or direct download on Linux; installs may prompt for admin/sudo).
2. On an explicit yes, re-run with `-Install` (Windows) or `--install` (macOS/Linux). On no, stop and list the missing tools as open items.
3. Relay every `Note:` line. These are steps the script can't do (Homebrew bootstrap, Docker Engine or Node.js on Linux, starting Docker Desktop, PATH changes). Wait for the operator to confirm each one is done.
4. Re-run the check script in a **new shell** so PATH changes apply. The agent's own shell keeps its old PATH, so a tool installed by winget (`terraform`, `passbolt`) still shows MISSING there. On Windows refresh it in the same command: `$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')`. Later phases run `passbolt` and `node` scripts from the PowerShell tool for the same reason (Git Bash launched earlier doesn't see winget's PATH).

Done when the check script exits 0, or the operator chooses to stop (record what remains).

### 3. Local workspace

1. Create `local/` at the repo root if it doesn't exist (it is gitignored).
2. If `local/registry.md` doesn't exist, create it from the **Registry Template** table in SETUP.md. An existing registry is the operator's record; keep it as is.

Done when `local/registry.md` exists.

### 4. Phase 0 decisions

Ask the operator for:

- **Operator mailbox**: a team/distribution address outside the future `<domain>`, or a new free-provider address. It owns break-glass accounts (Cloudflare).
- **Owners**: primary and backup people for break-glass accounts.

Write both into `local/registry.md` (`Operator mailbox` row; add an `Owners` row if absent). The registry holds non-secret values only; passwords and codes go to the operator's personal password manager until the vault exists (Phase 2).

Done when both values are recorded.

### 5. Manual items

Walk the operator through the Phase 0 items only they can do, confirming each:

- Install the Passbolt browser extension (https://www.passbolt.com/download).
- Launch `claude` in the repo and approve the project MCP servers from `.mcp.json`. OAuth for other servers happens in the phase that first uses them, **signed in with the environment's accounts**. See SETUP.md "Agent tooling".
- Create the Cloudflare account with the operator mailbox and prepare it for Registrar: 2FA, default payment method, default registrant contact, Domain Registration Agreement accepted. Skip whatever the operator confirms is already done.
- Complete OAuth for the `cloudflare` MCP server with that account (Registrar write, DNS/zone edit). Verify with a read-only call that returns the account ID, and record it as **Cloudflare account ID** in `local/registry.md`.

### 6. Report

Print the Phase 0 checklist from SETUP.md with each item marked done or pending (pending items with the reason), then name the next step: **Phase 1: Company Name & Domain**.
