---
name: setup-payroll-db
description: Run SETUP.md Phase 7b for the virtual enterprise. Adds the payroll PostgreSQL database to the on-prem site (payroll schema with employees, compensation, pay runs, payslips; payroll_owner for loaders and read-only payroll_reader for the SUT), syncs its secrets with the vault, and smoke-tests that the reader can read but not write. Use when starting 7b or resuming it.
disable-model-invocation: true
---

# Setup: Phase 7b Payroll Database

Walks the operator through [SETUP.md](../../../SETUP.md) Phase 7b. Run from the repo root; `compose` means `docker compose` in the on-prem stack folder on the on-prem host (`infra/compose/onprem/` locally, `~/ve/onprem` on a remote host, as in `/setup-onprem-site`).

**Why on-prem:** the SUT can't reach a database on the cloud site (the tunnel carries HTTP(S) only), so payroll lives behind the firewall with SQL Server and is reached through the SUT's gateway. That's a realistic legacy-payroll setup.

**Idempotent by design:** secrets sync through `secret-env.mjs`, `payroll-init` runs idempotent SQL (it also re-applies role passwords, so they always match the vault), and data loading is Phase 10's job.

## Steps

### 1. Preconditions

Phase 5b is done: the registry has **On-prem host / network** and **On-prem `BIND_ADDR`**, and the on-prem stack is running.

### 2. Secrets

- `node scripts/env/secret-env.mjs infra/compose/onprem/.env PAYROLL_PG_PASSWORD "Service & API" "On-prem payroll: postgres" --username postgres`
- `node scripts/env/secret-env.mjs infra/compose/onprem/.env PAYROLL_OWNER_PASSWORD "Service & API" "On-prem payroll: payroll_owner" --username payroll_owner`
- `node scripts/env/secret-env.mjs infra/compose/onprem/.env PAYROLL_READER_PASSWORD "Service & API" "On-prem payroll: payroll_reader" --username payroll_reader`

If 5432 is taken on `BIND_ADDR` (another PostgreSQL on this machine), set `PAYROLL_PORT` (for example 5433) with `set-env.mjs`.

### 3. Deploy

Remote host: copy the stack again first (`scp -r infra/compose/onprem <host>:~/ve/`, since `payroll/init/` and `.env` changed). Then `compose up -d` (the existing services are left as they are) and wait until `payroll-db` is healthy and `payroll-init` exited with code 0 (`compose ps -a`; on failure show `compose logs payroll-init`).

### 4. Smoke tests

Run from the stack folder:

1. **Schema exists:** `compose exec -T payroll-db psql -U postgres -d payroll -tAc "SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema='payroll'"` prints `compensation,employees,pay_runs,payslips`.
2. **Reader can read:** `compose exec -T -e PGPASSWORD="$(grep '^PAYROLL_READER_PASSWORD=' .env | cut -d= -f2-)" payroll-db psql -h localhost -U payroll_reader -d payroll -tAc "SELECT count(*) FROM payroll.employees"` prints a number (0 until Phase 10).
3. **Reader can't write:** the same login running `INSERT INTO payroll.pay_runs (site, period_start, period_end, pay_date, currency) VALUES ('x', '2000-01-01', '2000-01-31', '2000-01-31', 'USD')` fails with "permission denied".
4. **Reachable where the gateway runs:** from the host, `node -e "require('net').connect(<PAYROLL_PORT>, '<BIND_ADDR>').on('connect',function(){console.log('open');this.end()}).on('error',e=>console.log(e.code))"` prints `open`.

Done when all four pass.

### 5. Record and report

Record **Payroll DB** = `<BIND_ADDR>:<PAYROLL_PORT>/payroll` (on-prem). Note: data (personas' and generated employees' compensation, pay runs, payslips) loads in Phase 10; the SUT connects as `payroll_reader` through its gateway in Phase 12, and the `role-payroll` group decides which personas may see it in the SUT.

Next step: **Phase 8: SIEM Ingestion**.
